// Čítanie dostupnosti a ceny z HTML stránky dodávateľa — ČISTÉ funkcie, žiadna
// sieť, žiadna databáza. Testuje sa nad uloženými vzorkami stránok.
//
// Per-doménové pravidlá pre voľný text (`TEXT_AVAILABILITY_RULES`) a
// viditeľnú dostupnosť (`VISIBLE_AVAILABILITY_RULES`) žijú v
// `availability-domain-rules.ts` (issue 307 — vyčlenené, aby ani jeden zo
// súborov neprerástol eslint `max-lines: 400`) — tento súbor nesie len
// generický algoritmus čítania stránky.
//
// Úrovne v poradí od najspoľahlivejšej — ALE keď má doména vlastné pravidlo
// na VIDITEĽNÚ dostupnosť pri produkte (`VISIBLE_AVAILABILITY_RULES`, issue
// 225), táto sa krížovo overí proti JSON-LD a pri rozpore vyhrá „neviem":
//   1. JSON-LD `Product` (`schema.org`) — strojový údaj, ktorý dávajú Shoptet,
//      WooCommerce aj PrestaShop. Vie ale KLAMAŤ (issue 225: odimon.sk hlási
//      InStock, hoci stránka pri produkte hovorí "Nedostupný") — preto sa
//      na doménach s pravidlom na viditeľnú dostupnosť nikdy neberie ako
//      posledné slovo bez overenia.
//   2. `og:` / `product:` meta značky — ten istý údaj, keď JSON-LD chýba.
//   3. Voľný text stránky — LEN pre domény v `TEXT_AVAILABILITY_RULES`, a LEN
//      z VÝREZU, ktorý pravidlo označí za oblasť TOHTO produktu (issue 223:
//      celostránkový voľný text chytal marketingovú vetu z pätičky). Inde je
//      dohad horší než „neviem".
//
// Čokoľvek, čo neprejde ani jednou úrovňou, je `unknown` — a `unknown` nikdy
// neprepne produkt (issue 213).

import {
  grubeOffers,
  hasKnownAvailabilityRule,
  readWetlandCombination,
  textAvailabilityRuleFor,
  unwrapWetlandCombinationResponse,
  visibleAvailabilityFor,
  wetlandEnumerateCombinations,
  wetlandSuffixMismatch,
} from "./availability-domain-rules.js";
import {
  availabilityFromText,
  type CombinationTarget,
  hostOf,
  type SupplierAvailability,
} from "./availability-primitives.js";
import { shoptetMultiVariantSizeList } from "./shoptet-multivariant.js";

export type { CombinationTarget, SupplierAvailability };
export { availabilityFromText, hostOf };

export type SupplierStockSource = "json_ld" | "meta" | "text" | "size_list" | "none";

export interface ParsedPage {
  readonly availability: SupplierAvailability;
  readonly availabilityText: string;
  readonly price: number | null;
  readonly source: SupplierStockSource;
}

/** `true`, keď má doména (alebo jej poddoména) overené pravidlo na voľný text. */
export function isTrustedTextHost(url: string): boolean {
  return textAvailabilityRuleFor(url) !== null;
}

// `schema.org` tokeny. Zámerne sa NEBERIE `PreOrder`/`BackOrder` ako
// dostupné: znamenajú "objednáme, príde neskôr", čo pri prepínaní nášho
// produktu na "Skladom" nie je pravda — zákazník by dostal sľub, ktorý
// dodávateľ nedrží.
const SCHEMA_AVAILABLE = new Set(["instock", "limitedavailability", "onlineonly", "instoreonly"]);
const SCHEMA_UNAVAILABLE = new Set([
  "outofstock",
  "soldout",
  "discontinued",
  "preorder",
  "backorder",
]);

/** `schema.org`/`og` token dostupnosti → náš stav. Neznámy token → `unknown`. */
export function availabilityFromSchemaToken(token: string): SupplierAvailability {
  const last = token.split("/").pop() ?? "";
  const normalized = last.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "") return "unknown";
  if (SCHEMA_AVAILABLE.has(normalized)) return "available";
  if (SCHEMA_UNAVAILABLE.has(normalized)) return "unavailable";
  return "unknown";
}

/**
 * Cena z voľného tvaru: „59,90", „59.90", „1 299,00 €", číslo. Keď sú
 * prítomné obe oddeľovacie znamienka, desatinné je to POSLEDNÉ („1.299,00").
 */
export function parsePrice(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  let text = raw.replace(/[^0-9,.-]/g, "");
  if (text === "") return null;
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    text = lastComma > lastDot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (lastComma >= 0) {
    text = text.replace(",", ".");
  }
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
}

/** Odstráni `<script>`/`<style>` a značky — zvyšok je viditeľný text stránky. */
export function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface SchemaHit {
  readonly availability: SupplierAvailability;
  readonly token: string;
  readonly price: number | null;
}

function collectOffers(node: unknown, into: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectOffers(item, into);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const type = record["@type"];
  const isOffer =
    (typeof type === "string" && type.toLowerCase().includes("offer")) ||
    (Array.isArray(type) && type.some((t) => typeof t === "string" && t.toLowerCase().includes("offer")));
  if (isOffer) into.push(record);
  for (const value of Object.values(record)) collectOffers(value, into);
}

/** Dostupnosť + cena z JSON-LD `Product`/`Offer`. Prvá ponuka s údajom vyhráva. */
export function fromJsonLd(html: string): SchemaHit | null {
  const blocks = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const offers: Record<string, unknown>[] = [];
  for (const block of blocks) {
    const body = block[1];
    if (body === undefined) continue;
    try {
      collectOffers(JSON.parse(body), offers);
    } catch {
      // Nevalidný JSON-LD je bežný — jednoducho sa preskočí, nikdy nezhodí beh.
    }
  }
  for (const offer of offers) {
    const raw = offer["availability"];
    if (typeof raw !== "string") continue;
    const availability = availabilityFromSchemaToken(raw);
    if (availability === "unknown") continue;
    return { availability, token: raw, price: parsePrice(offer["price"]) };
  }
  return null;
}

function metaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const direct = pattern.exec(html);
  if (direct?.[1] !== undefined) return direct[1];
  // Poradie atribútov nie je v HTML pevné — `content` môže stáť pred `property`.
  const reversed = new RegExp(
    `<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`,
    "i",
  );
  const flipped = reversed.exec(html);
  return flipped?.[1] ?? null;
}

/** Dostupnosť + cena z `og:`/`product:` meta značiek. */
export function fromMetaTags(html: string): SchemaHit | null {
  // Každý kandidát sa skúsi zvlášť: keď prvá značka nesie token, ktorému
  // nerozumieme, ďalšia ho ešte môže niesť zrozumiteľne — vzdať sa hneď pri
  // prvej by zahodilo použiteľný údaj o pár znakov ďalej.
  for (const property of ["product:availability", "og:availability", "availability"]) {
    const token = metaContent(html, property);
    if (token === null) continue;
    const availability = availabilityFromSchemaToken(token);
    if (availability === "unknown") continue;
    const price =
      parsePrice(metaContent(html, "product:price:amount")) ??
      parsePrice(metaContent(html, "og:price:amount"));
    return { availability, token, price };
  }
  return null;
}

export interface SizeAvailability {
  /** Presný text veľkosti u DODÁVATEĽA (napr. "L/XL"), nie náš vlastný size_label. */
  readonly sizeLabel: string;
  readonly availability: "available" | "unavailable";
}

/**
 * Voliteľná enumerácia VŠETKÝCH kombinácií (veľkostí) hosta (issue 552).
 * Generický hák — host-špecifická je len funkcia, ktorá z bázovej stránky
 * vyrobí URL per veľkosť (`targets`) a rozbalí odpoveď na HTML pre `read`
 * (`unwrap`). `suffixMismatch` je voliteľná diagnostika (zastaraná prípona
 * odkazu vs. načítaná kombinácia) na logovanie. Vďaka tomu ho dostane
 * ĽUBOVOĽNÝ ďalší PrestaShop host (tthunt.sk/pyra.eu, #555) za cenu jednej
 * funkcie.
 */
export interface CombinationEnumerator {
  readonly targets: (html: string, link: string) => readonly CombinationTarget[];
  readonly unwrap: (rawResponse: string) => string;
  readonly suffixMismatch?: (html: string, link: string) => { readonly expected: string; readonly actual: string } | null;
}

interface SizeAvailabilityRule {
  readonly host: string;
  readonly read: (html: string) => readonly SizeAvailability[];
  // issue 552: enumerácia všetkých veľkostí (dnes len wetland.sk).
  readonly enumerate?: CombinationEnumerator;
}

// Živo overené (issue 224 code review): `class="clearfix product-variants-item"`
// NIE JE unikátna pre veľkosť — TÁ ISTÁ trieda nesie aj "Odstín"/"Barva"
// (odtieň/farba) skupinu na tej istej stránke (3 skupiny na overenej vzorke
// shop.lasting.eu). Rozlišuje ich AŽ vlastný popisok
// `<span class="control-label">VELIKOST…`. Bez tohto rozlíšenia by čítač
// (presne ako issue 223's huntingshop.eu karuselová kolízia) mohol zobrať
// veľkosti z INEJ skupiny — alebo, keby stránka niekde nižšie ukazovala
// súvisiaci produkt s vlastným plným výberom veľkostí, aj z NEHO.
const VELIKOST_GROUP_START_RE = /<div\b[^>]*class="[^"]*product-variants-item[^"]*"[^>]*>/gi;

/**
 * shop.lasting.eu (issue 224): PrestaShop nesie dostupnosť KAŽDEJ veľkosti
 * v triede `<li>` veľkostného zoznamu — `sklademANO`/`sklademNE` — skutočná
 * veľkosť je v `title=""` atribúte vnoreného `<input>`. Stránkové JSON-LD
 * hlási dostupnosť len JEDNEJ (predvolenej/`checked`) veľkosti a vie byť
 * priamo v rozpore s týmto zoznamom (živý dôkaz, issue 224: JSON-LD hlási
 * InStock pre veľkosť, ktorej vlastný zoznam hovorí `sklademNE`) — preto sa
 * JSON-LD pri viacveľkostnom produkte na tejto doméne NIKDY neberie ako
 * dostupnosť KONKRÉTNEJ veľkosti (`parsePage` sa pre tento odkaz vôbec
 * nepoužije, viď `run.ts`). Čítanie je OHRANIČENÉ na výrez medzi popiskom
 * "VELIKOST" a ZAČIATKOM ĎALŠEJ `product-variants-item` skupiny (alebo
 * koncom stránky) — nikdy na celý dokument.
 */
function lastingSizeList(html: string): readonly SizeAvailability[] {
  const groups = [...html.matchAll(VELIKOST_GROUP_START_RE)];
  // Kontrola popisku je ukotvená (`^`) HNEĎ za otváracou značkou TEJTO
  // skupiny — nikdy len "obsahuje niekde v okolí", inak by krátka
  // predchádzajúca skupina (napr. "Odstín") nechtiac zasiahla do popisku
  // NASLEDUJÚCEJ skupiny cez široké okno.
  const sizeGroupIndex = groups.findIndex((m) => {
    const afterOpenTag = html.slice(m.index + m[0].length, m.index + m[0].length + 200);
    return /^\s*<span\b[^>]*class="[^"]*control-label[^"]*"[^>]*>\s*VELIKOST/i.test(afterOpenTag);
  });
  if (sizeGroupIndex === -1) return [];
  const sizeStart = groups[sizeGroupIndex]?.index ?? 0;
  const sizeEnd = groups[sizeGroupIndex + 1]?.index ?? html.length;
  const region = html.slice(sizeStart, sizeEnd);

  const items = [...region.matchAll(/<li\b[^>]*class="[^"]*(sklademANO|sklademNE)[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)];
  const result: SizeAvailability[] = [];
  for (const [, cls, inner] of items) {
    const title = /title="([^"]*)"/.exec(inner ?? "")?.[1]?.trim();
    if (title === undefined || title === "") continue;
    result.push({ sizeLabel: title, availability: cls === "sklademANO" ? "available" : "unavailable" });
  }
  return result;
}

const CHIRUCA_SELECT_RE = /<select\b[^>]*\bid="simple-variants-select"[^>]*>([\s\S]*?)<\/select>/i;
const CHIRUCA_OPTION_RE = /<option\b[^>]*>([\s\S]*?)<\/option>/gi;
const CHIRUCA_SIZE_TEXT_RE = /^Veľkosť:\s*([^-]+?)\s*-\s*(.+)$/i;

/**
 * chiruca.sk (issue 227): `<select id="simple-variants-select">` nesie
 * PRESNE JEDEN `<option>` na veľkosť, s veľkosťou aj dostupnosťou v tom
 * istom viditeľnom texte ("Veľkosť: 38 - Vypredané (€100)") — na rozdiel
 * od shop.lasting.eu tu netreba hľadať skupinovú hranicu ani popisok, celý
 * `<select>` patrí jednému produktu. Placeholder `<option>` ("Zvoľte
 * variant") nezačína "Veľkosť:", takže sa jednoducho preskočí bez
 * osobitného rozlíšenia. Dostupnosť sa číta cez existujúci
 * `availabilityFromText` (rovnaké slová "Skladom"/"Vypredané" ako inde),
 * nikdy z `data-stock` atribútu — ten by bol dohad bez preukázateľného
 * mapovania (`-1`/`-2`), zatiaľ čo text je to, čo naozaj vidí zákazník.
 */
function chirucaSizeList(html: string): readonly SizeAvailability[] {
  const selectMatch = CHIRUCA_SELECT_RE.exec(html);
  if (selectMatch === null) return [];
  const body = selectMatch[1] ?? "";
  const result: SizeAvailability[] = [];
  for (const [, raw] of body.matchAll(CHIRUCA_OPTION_RE)) {
    const clean = (raw ?? "").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
    const sizeMatch = CHIRUCA_SIZE_TEXT_RE.exec(clean);
    if (sizeMatch === null) continue;
    const sizeLabel = (sizeMatch[1] ?? "").trim();
    const rest = sizeMatch[2] ?? "";
    if (sizeLabel === "") continue;
    const { availability } = availabilityFromText(rest);
    if (availability === "unknown") continue;
    result.push({ sizeLabel, availability });
  }
  return result;
}

/**
 * wetland.sk (issue 551): PrestaShop stránka ukazuje VŽDY JEDNU kombináciu —
 * tú zo prípony odkazu `-<id_product>-<id_product_attribute>`. Jej dostupnosť
 * (quantity + krížová kontrola JSON-LD z issue 549) a názov(-y) hodnôt sú v
 * `data-product` (`readWetlandCombination`, ktorý vráti len VEĽKOSTNÚ skupinu
 * — farba/odtieň vylúčené). Vraciame JEDNU položku na názov veľkosti
 * (kandidátny zoznam, z ktorého `matchSizeLabel` v `run.ts` vyberie NAŠU
 * zhodnú veľkosť; ostatné naše veľkosti toho odkazu → `unknown`, presne ako
 * lasting/chiruca, keď stránka veľkosť neukáže).
 *
 * Produkt BEZ `attributes` (jednoveľkostný — pero, opasok, olej) → prázdny
 * zoznam → `parseSizeAvailability` vráti `null` → `run.ts` padne na blanket
 * riadok cez `parsePage`/`VISIBLE_AVAILABILITY_RULES` (issue 549 nezmenené).
 *
 * Krížová kontrola JSON-LD je TU (nie v `parsePage`, ktorý per-veľkosť vetva
 * na dostupnosť nevolá): rozpor quantity vs JSON-LD → prázdno → blanket vetva
 * to vyhodnotí ako `unknown` (fail-closed, nikdy `available` na rozpore —
 * rovnaká disciplína ako `parsePage` VISIBLE, issue 225/549). Nečitateľné
 * quantity (`unknown`) → tiež prázdno → blanket → `unknown`.
 */
function wetlandSizeList(html: string): readonly SizeAvailability[] {
  const combo = readWetlandCombination(html);
  if (combo.attributeNames.length === 0) return [];
  if (combo.availability === "unknown") return [];
  const jsonLd = fromJsonLd(html);
  if (jsonLd !== null && jsonLd.availability !== combo.availability) return [];
  const availability = combo.availability;
  return combo.attributeNames.map((name) => ({ sizeLabel: name, availability }));
}

/**
 * grube.de/grube.sk (issue 557): per-veľkosť dostupnosť z JSON-LD ponúk
 * (`grubeOffers`, `availability-domain-rules.ts`). Berie LEN ponuky s „Größe"
 * tokenom a dedupuje ich podľa veľkosti cez `mergeSizeAvailability` — tá istá
 * veľkosť vo viacerých FARBÁCH so zhodnou dostupnosťou = jedna položka, s
 * ROZPORNOU (jedna farba skladom, druhá vypredaná) = ZAHODÍ (fail-closed; náš
 * variant nenesie farbu, takže sa nemá ako rozhodnúť → `unknown`). Produkt bez
 * „Größe" ponúk (jeden Offer, jednoveľkostný) → prázdno → `parseSizeAvailability`
 * `null` → `run.ts` blanket cez `grubeVisibleAvailability`.
 */
function grubeSizeList(html: string): readonly SizeAvailability[] {
  const sized = grubeOffers(html).flatMap((offer): SizeAvailability[] =>
    offer.sizeLabel === null ? [] : [{ sizeLabel: offer.sizeLabel, availability: offer.availability }],
  );
  return mergeSizeAvailability(sized);
}

const SIZE_AVAILABILITY_RULES: readonly SizeAvailabilityRule[] = Object.freeze([
  { host: "shop.lasting.eu", read: lastingSizeList },
  { host: "chiruca.sk", read: chirucaSizeList },
  // issue 557: grube per-veľkosť z JSON-LD (všetky veľkosti v jednom GET →
  // žiadny enumerátor). grube.de aj grube.sk je ten istý e-shop.
  { host: "grube.de", read: grubeSizeList },
  { host: "grube.sk", read: grubeSizeList },
  // issue 558: luko.cz Shoptet viacvariantová stránka (generické pravidlo
  // `shoptet-multivariant.ts`). Jednovariantová luko stránka ostáva na
  // `shoptetLabelAvailability` (TEXT rule). zubicek.cz zámerne NEregistrované —
  // žiadny živo overený vypredaný protipól (viď issue 558, disciplína issue 230).
  { host: "luko.cz", read: shoptetMultiVariantSizeList },
  {
    host: "wetland.sk",
    read: wetlandSizeList,
    // issue 552: enumerácia všetkých veľkostí cez PrestaShop action=refresh.
    enumerate: {
      targets: wetlandEnumerateCombinations,
      unwrap: unwrapWetlandCombinationResponse,
      suffixMismatch: wetlandSuffixMismatch,
    },
  },
  {
    // issue 556: tthunt.sk je tá istá PrestaShop 1.7/8 šablóna ako wetland.sk —
    // ten istý `data-product` JSON (quantity + attributes) aj `<select
    // name="group[N]">`, a `action=refresh` GET naživo overený 2026-09-18, že
    // funguje aj tu. Preto znovupoužíva `wetlandSizeList` aj celý wetland
    // enumerátor (generický `CombinationEnumerator` z issue 552) bez forku.
    host: "tthunt.sk",
    read: wetlandSizeList,
    enumerate: {
      targets: wetlandEnumerateCombinations,
      unwrap: unwrapWetlandCombinationResponse,
      suffixMismatch: wetlandSuffixMismatch,
    },
  },
]);

function sizeAvailabilityRuleFor(url: string): SizeAvailabilityRule | null {
  const host = hostOf(url);
  if (host === "") return null;
  return SIZE_AVAILABILITY_RULES.find((rule) => host === rule.host || host.endsWith(`.${rule.host}`)) ?? null;
}

/**
 * `true`, keď HOST (nie URL) má pravidlo na čítanie zoznamu veľkostí
 * (`SIZE_AVAILABILITY_RULES`) — issue 551 (dodatok): `run.ts`'s `isLinkFresh`
 * ho potrebuje, aby plošný riadok (`size_label=''`) na takej doméne nikdy
 * nebral ako čerstvý (mohla ho zapísať len staršia verzia pravidla).
 */
export function hasSizeAvailabilityRule(host: string): boolean {
  return SIZE_AVAILABILITY_RULES.some((rule) => host === rule.host || host.endsWith(`.${rule.host}`));
}

/**
 * Zoznam veľkostí a ich dostupnosti PRIAMO zo stránky (issue 224), alebo
 * `null`, keď doména nemá overené pravidlo ALEBO stránka žiadny takýto
 * zoznam neobsahuje (napr. jednoveľkostný produkt). `null` je zámerne INÝ
 * výsledok než prázdne pole — prázdne pole by znamenalo "zoznam sa hľadal a
 * je prázdny" (nemalo by nastať), `null` znamená "túto úroveň čítania nemá
 * na tejto stránke zmysel skúšať".
 */
export function parseSizeAvailability(html: string, url: string): readonly SizeAvailability[] | null {
  const rule = sizeAvailabilityRuleFor(url);
  if (rule === null) return null;
  const sizes = rule.read(html);
  return sizes.length > 0 ? sizes : null;
}

/**
 * Enumerátor kombinácií pre HOST odkazu (issue 552), alebo `null`, keď host
 * nemá size-rule ALEBO jeho size-rule enumeráciu nedeklaruje (napr.
 * shop.lasting.eu — celý zoznam veľkostí je na jednej stránke, netreba per-
 * veľkosť GET). `run.ts` ho volá po base GET.
 */
export function sizeCombinationEnumeratorFor(url: string): CombinationEnumerator | null {
  return sizeAvailabilityRuleFor(url)?.enumerate ?? null;
}

/**
 * Rozbalí a prečíta jednu `action=refresh` odpoveď (issue 552): host-špecifický
 * `unwrap` vyberie HTML `product_details`, existujúci `read` (napr.
 * `wetlandSizeList`) z neho prečíta veľkosť + dostupnosť. Prázdno, keď host
 * nemá enumeráciu alebo sa odpoveď nedá prečítať (fail-closed).
 */
export function parseCombinationResponse(rawResponse: string, url: string): readonly SizeAvailability[] {
  const rule = sizeAvailabilityRuleFor(url);
  if (rule?.enumerate === undefined) return [];
  return rule.read(rule.enumerate.unwrap(rawResponse));
}

/**
 * Zlúči viac zoznamov veľkostí do jedného, deduplikovaného podľa NÁZVU
 * veľkosti (issue 552) — bázová kombinácia + enumeračné odpovede sa prekrývajú
 * v predvolenej veľkosti. Rovnaká veľkosť s ROVNAKOU dostupnosťou → jedna
 * položka; s ROZPORNOU dostupnosťou → veľkosť sa ZAHODÍ (fail-closed, naša
 * veľkosť potom padne na `unknown` cez `matchSizeLabel` bez hitu — nikdy dohad,
 * rovnaká disciplína ako rozpor JSON-LD vs quantity).
 */
export function mergeSizeAvailability(...lists: readonly (readonly SizeAvailability[])[]): readonly SizeAvailability[] {
  const byLabel = new Map<string, SizeAvailability | null>();
  for (const list of lists) {
    for (const size of list) {
      const existing = byLabel.get(size.sizeLabel);
      if (existing === undefined) {
        byLabel.set(size.sizeLabel, size);
      } else if (existing !== null && existing.availability !== size.availability) {
        byLabel.set(size.sizeLabel, null); // rozpor → zahodiť
      }
    }
  }
  const result: SizeAvailability[] = [];
  for (const value of byLabel.values()) {
    if (value !== null) result.push(value);
  }
  return result;
}

/** Rozdelí veľkostné označenie na porovnateľné časti — oddeľovače (`/`, `-`,
 * medzera, ...) preč, každá časť veľkými písmenami. Prázdne označenie nemá
 * žiadnu časť (nikdy sa nespáruje so žiadnou veľkosťou). */
function sizeTokens(label: string): readonly string[] {
  return label
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((part) => part !== "");
}

/**
 * Spáruje NÁŠ `variant.size_label` (napr. "L-X") s presne JEDNOU veľkosťou
 * zo zoznamu dodávateľa (napr. "L/XL") — issue 224. Zámerne TOLERANTNÉ na
 * skrátenie: náš Shoptet-ov `size_label` niekedy nesie skrátený tvar tej
 * istej veľkosti (overené naživo v produkčnej DB: "L-X" u nás = "L/XL" u
 * dodávateľa) — zhoda platí, keď majú OBE strany rovnaký POČET častí a na
 * KAŽDEJ pozícii sú časti buď PRESNE zhodné, alebo je jedna PREFIXOM
 * druhej. Nikdy iný počet častí, nikdy iný prvý znak — to by už bol dohad.
 * Viac než JEDNA zhoda je nejednoznačná a počíta sa ako ŽIADNA — nikdy sa
 * neuhádne, ktorá je správna (rovnaká disciplína ako `unknown` v `parsePage`).
 */
export function matchSizeLabel(ourSizeLabel: string, supplierSizeLabels: readonly string[]): string | null {
  const ours = sizeTokens(ourSizeLabel);
  if (ours.length === 0) return null;
  const matches = supplierSizeLabels.filter((candidate) => {
    const theirs = sizeTokens(candidate);
    if (theirs.length !== ours.length) return false;
    return ours.every((part, i) => {
      const other = theirs[i] ?? "";
      return part === other || part.startsWith(other) || other.startsWith(part);
    });
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Celé čítanie stránky. `url` rozhoduje o dvoch veciach: (a) či sa smie
 * použiť voľný text a z KTOREJ oblasti (issue 223), (b) či sa JSON-LD musí
 * krížovo overiť proti viditeľnej dostupnosti PRI produkte skôr, než sa mu
 * uverí (issue 225). Mimo overených domén/pravidiel sa radšej vráti
 * `unknown` než dohad.
 */
export function parsePage(html: string, url: string): ParsedPage {
  const jsonLd = fromJsonLd(html);

  const visible = visibleAvailabilityFor(url, html);
  if (visible !== null) {
    if (jsonLd !== null && jsonLd.availability !== visible.availability) {
      // Stránka si protirečí (JSON-LD vs viditeľná dostupnosť) — človek
      // rozhodne, nikdy sa nevyhlási `available` na takomto rozpore.
      return { availability: "unknown", availabilityText: "", price: null, source: "none" };
    }
    return {
      availability: visible.availability,
      availabilityText: visible.text,
      price: jsonLd?.price ?? null,
      source: "text",
    };
  }

  // issue 330: doména bez AKÉHOKOĽVEK pravidla (ani visible, ani text — teda
  // sa preň nikdy nespravila žiadna overovacia práca, presne prípad roy.sk)
  // sa nesmie spoliehať na strojový JSON-LD/meta `available` bez druhej
  // kontroly — fail-closed, `unknown` namiesto dôvery naslepo. Domény S
  // pravidlom (text alebo visible) sa nemenia, ich `available` ostáva ako
  // doteraz.
  const knownDomain = hasKnownAvailabilityRule(url);

  if (jsonLd !== null) {
    if (jsonLd.availability === "available" && !knownDomain) {
      return { availability: "unknown", availabilityText: "", price: null, source: "none" };
    }
    return {
      availability: jsonLd.availability,
      availabilityText: jsonLd.token,
      price: jsonLd.price,
      source: "json_ld",
    };
  }

  const meta = fromMetaTags(html);
  if (meta !== null) {
    if (meta.availability === "available" && !knownDomain) {
      return { availability: "unknown", availabilityText: "", price: null, source: "none" };
    }
    return {
      availability: meta.availability,
      availabilityText: meta.token,
      price: meta.price,
      source: "meta",
    };
  }

  const textRule = textAvailabilityRuleFor(url);
  if (textRule !== null) {
    const region = textRule.extractRegion(html, url);
    if (region === null) {
      return { availability: textRule.whenRegionMissing, availabilityText: "", price: null, source: "text" };
    }
    const text = availabilityFromText(region);
    if (text.availability !== "unknown") {
      return {
        availability: text.availability,
        availabilityText: text.matched,
        price: null,
        source: "text",
      };
    }
  }

  return { availability: "unknown", availabilityText: "", price: null, source: "none" };
}
