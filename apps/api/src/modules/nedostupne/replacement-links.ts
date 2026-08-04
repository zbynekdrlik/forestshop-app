import { asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { nedostupneReplacementLinks } from "../../db/schema.js";

// issue 238: majiteľove RUČNE vložené odkazy na náhradné produkty — nahrádza
// automatický návrh z `product.relatedCodes` (majiteľ: "nechcem aby to
// uvádzalo tieto náhrady - je to blbosť, to sú súvisiace produkty - nie
// podobné, nie náhrady"). Kľúčované `variantCode` (plain, bez FK — rovnaká
// konvencia ako `nedostupne_state`, `.claude/rules/nedostupne.md`), viac
// riadkov na ten istý kód = viac liniek na ten istý tovar.

export interface ReplacementLink {
  readonly id: string;
  readonly url: string;
}

/** Zoradenie podľa VLOŽENIA (najstarší prvý) — majiteľ vkladá odkazy v
 * poradí, v akom má zmysel ich zákazníkovi ukázať (prvý pridaný = zvyčajne
 * najviac odporúčaný), nie abecedne/náhodne. `asc(id)` je len deterministický
 * tie-break pre riadky vložené v tej istej transakcii/millisekunde. */
export async function listReplacementLinksByVariant(
  db: Pick<Database, "select">,
  variantCodes: readonly string[],
): Promise<ReadonlyMap<string, ReplacementLink[]>> {
  const map = new Map<string, ReplacementLink[]>();
  if (variantCodes.length === 0) return map;
  const rows = await db
    .select({ id: nedostupneReplacementLinks.id, variantCode: nedostupneReplacementLinks.variantCode, url: nedostupneReplacementLinks.url })
    .from(nedostupneReplacementLinks)
    .where(inArray(nedostupneReplacementLinks.variantCode, [...variantCodes]))
    .orderBy(asc(nedostupneReplacementLinks.createdAt), asc(nedostupneReplacementLinks.id));
  for (const row of rows) {
    const list = map.get(row.variantCode);
    const link = { id: row.id, url: row.url };
    if (list === undefined) map.set(row.variantCode, [link]);
    else list.push(link);
  }
  return map;
}

export async function listReplacementLinksForVariant(db: Pick<Database, "select">, variantCode: string): Promise<readonly ReplacementLink[]> {
  return (await listReplacementLinksByVariant(db, [variantCode])).get(variantCode) ?? [];
}

export async function addReplacementLink(db: Database, variantCode: string, url: string, now: Date): Promise<ReplacementLink> {
  const [row] = await db
    .insert(nedostupneReplacementLinks)
    .values({ variantCode, url, createdAt: now })
    .returning({ id: nedostupneReplacementLinks.id, url: nedostupneReplacementLinks.url });
  if (row === undefined) throw new Error("odkaz náhrady sa nepodarilo vložiť");
  return row;
}

/** `true` = riadok reálne existoval a bol zmazaný; `false` = neznáme `id`
 * (napr. dvojklik na "zmazať", medzičasom už zmazané inou žiadosťou). */
export async function removeReplacementLink(db: Database, id: string): Promise<boolean> {
  const deleted = await db.delete(nedostupneReplacementLinks).where(eq(nedostupneReplacementLinks.id, id)).returning({ id: nedostupneReplacementLinks.id });
  return deleted.length > 0;
}
