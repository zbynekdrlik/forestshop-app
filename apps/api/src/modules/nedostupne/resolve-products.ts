import { eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { shopProductUrl, variants } from "../../db/schema.js";

// issue 347: majiteľove RUČNE vložené odkazy náhrad (`replacement-links.ts`)
// nesú LEN url — appka k nim nepozná názov/kód (issue 238's zámerné
// rozhodnutie). E-mailová karta ("Radi by sme vám ponúkli tieto alternatívne
// produkty") ale potrebuje NÁZOV, OBRÁZOK a CENU. Namiesto duplikovania
// týchto dát (majiteľ by ich musel zadávať ručne pri KAŽDOM vloženom odkaze)
// appka spätne dohľadá zhodu proti tomu, čo UŽ MÁ — `shop_product_url`
// (adresa + obrázok z feedu pre porovnávače) a `variants` (názov + cena z
// katalógu). Keď sa zhoda nenájde, padá sa PRESNE na pôvodné správanie
// (`label = url`, žiadny obrázok/cena) — nikdy sa nič nedohaduje/nefabrikuje,
// rovnaká disciplína ako `nedostupne.md`'s "nikdy nevyrábať adresu odhadom".

export interface ResolvedReplacementProduct {
  readonly url: string;
  readonly label: string;
  readonly imageUrl?: string;
  readonly priceText?: string;
}

/** Adresa BEZ query stringu — majiteľ zvyčajne vloží bázovú adresu produktu
 * (bez `?variantId=`), feed ju nesie S `?variantId=…`. Porovnanie na tejto
 * úrovni nájde zhodu bez ohľadu na to, ktorá strana query string nesie. */
function basePath(url: string): string {
  const qIdx = url.indexOf("?");
  return (qIdx === -1 ? url : url.slice(0, qIdx)).trim();
}

/** Appka nikdy nepočíta menu/desatinné miesta pre zákazníka inak, než ako ich
 * ukazuje katalóg — `variant.price` je `numeric` stĺpec (string, 2 desatinné
 * miesta, `.claude/rules/database.md`). `null` = cenu nemáme, karta ju
 * jednoducho vynechá (nikdy neukáže "0,00 €" ani odhad). */
function formatPriceText(price: string | null, currency: string | null): string | undefined {
  if (price === null) return undefined;
  const amount = Number(price);
  if (!Number.isFinite(amount)) return undefined;
  const formatted = amount.toFixed(2).replace(".", ",");
  return currency === null || currency === "" || currency === "EUR" ? `${formatted} €` : `${formatted} ${currency}`;
}

async function findMatchingCode(db: Pick<Database, "select">, trimmedUrl: string): Promise<{ code: string; imageUrl: string | null } | null> {
  const [exact] = await db
    .select({ code: shopProductUrl.code, imageUrl: shopProductUrl.imageUrl })
    .from(shopProductUrl)
    .where(eq(shopProductUrl.url, trimmedUrl))
    .limit(1);
  if (exact !== undefined) return exact;

  // Žiadna PRESNÁ zhoda — skús zhodu podľa CESTY (bez query stringu), keď
  // majiteľ vložil/feed nesie inú variáciu tej istej adresy (napr. iná
  // veľkosť produktu — rovnaký produkt, iný `?variantId=`). Determinizmus
  // pri viacerých zhodách: najmenší kód.
  const base = basePath(trimmedUrl);
  if (base === "") return null;
  const [byPath] = await db
    .select({ code: shopProductUrl.code, imageUrl: shopProductUrl.imageUrl })
    .from(shopProductUrl)
    .where(sql`split_part(${shopProductUrl.url}, '?', 1) = ${base}`)
    .orderBy(shopProductUrl.code)
    .limit(1);
  return byPath ?? null;
}

async function resolveOne(db: Pick<Database, "select">, url: string): Promise<ResolvedReplacementProduct> {
  const trimmed = url.trim();
  if (trimmed === "") return { url, label: url };

  const match = await findMatchingCode(db, trimmed);
  if (match === null) return { url, label: url };

  const [variant] = await db
    .select({ name: variants.name, price: variants.price, currency: variants.currency })
    .from(variants)
    .where(eq(variants.code, match.code))
    .limit(1);
  // Adresu vo feede sme našli, ale variant medzičasom zmizol z katalógu
  // (zriedkavé, ale nie nemožné) — padni na pôvodné správanie, nikdy
  // nevyrábaj kartu bez názvu.
  if (variant === undefined) return { url, label: url };

  const priceText = formatPriceText(variant.price, variant.currency);
  return {
    url,
    label: variant.name,
    ...(match.imageUrl !== null ? { imageUrl: match.imageUrl } : {}),
    ...(priceText !== undefined ? { priceText } : {}),
  };
}

/** Zachováva PORADIE vstupu (rovnaké poradie, v akom majiteľ odkazy vložil,
 * `replacement-links.ts`'s `listReplacementLinksForVariant`). */
export async function resolveReplacementProducts(
  db: Pick<Database, "select">,
  urls: readonly string[],
): Promise<readonly ResolvedReplacementProduct[]> {
  const out: ResolvedReplacementProduct[] = [];
  for (const url of urls) out.push(await resolveOne(db, url));
  return out;
}
