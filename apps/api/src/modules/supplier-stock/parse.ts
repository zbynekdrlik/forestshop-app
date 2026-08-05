// Čítanie dostupnosti a ceny z HTML stránky dodávateľa — ČISTÉ funkcie, žiadna
// sieť, žiadna databáza. Testuje sa nad uloženými vzorkami stránok.
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

export type SupplierAvailability = "available" | "unavailable" | "unknown";
export type SupplierStockSource = "json_ld" | "meta" | "text" | "size_list" | "none";

export interface ParsedPage {
  readonly availability: SupplierAvailability;
  readonly availabilityText: string;
  readonly price: number | null;
  readonly source: SupplierStockSource;
}

/** Doména bez `www.`, malými písmenami. Neplatná URL → prázdny reťazec. */
export function hostOf(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
  return host.startsWith("www.") ? host.slice(4) : host;
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

// Vypredané sa kontroluje PRVÉ — stránka, ktorá povie "Vypredané", je
// rozhodná aj keď sa inde na nej vyskytne slovo "skladom" (napr. v odporúčaných
// produktoch). Slovenské, české aj anglické tvary, s diakritikou aj bez nej.
const OUT_KEYWORDS: readonly string[] = Object.freeze([
  "vypredané",
  "vypredane",
  "vypredaný",
  "vypredany",
  "vyprodáno",
  "vyprodano",
  "nedostupné",
  "nedostupne",
  "nedostupný",
  "nedostupny",
  "nie je skladom",
  "není skladem",
  "neni skladem",
  "momentálne nedostupné",
  "momentalne nedostupne",
  // Český tvar s mäkkým "ě" (issue 227, tenolix.cz) — INÝ reťazec než
  // slovenské "momentálne" vyššie, obe sa musia kontrolovať samostatne.
  "momentálně nedostupné",
  "dočasne nedostupné",
  "docasne nedostupne",
  "predaj skončil",
  "predaj skoncil",
  "out of stock",
  "sold out",
]);

const IN_KEYWORDS: readonly string[] = Object.freeze([
  "skladom",
  "na sklade",
  "skladem",
  "ihneď k odberu",
  "ihned k odberu",
  "posledné kusy",
  "posledne kusy",
  "posledný kus",
  "posledny kus",
  "in stock",
]);

/**
 * Dostupnosť z voľného textu. Vypredané vyhráva nad skladom (rozhodný zápor).
 * Vracia aj to, KTORÉ slovo rozhodlo — ide do `availabilityText`, aby bolo
 * v appke vidieť, na základe čoho sa rozhodlo.
 */
export function availabilityFromText(text: string): {
  readonly availability: SupplierAvailability;
  readonly matched: string;
} {
  const lower = text.toLowerCase();
  const out = OUT_KEYWORDS.find((keyword) => lower.includes(keyword));
  if (out !== undefined) return { availability: "unavailable", matched: out };
  const inStock = IN_KEYWORDS.find((keyword) => lower.includes(keyword));
  if (inStock !== undefined) return { availability: "available", matched: inStock };
  return { availability: "unknown", matched: "" };
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

interface TextAvailabilityRule {
  readonly host: string;
  /**
   * Vyberie z CELEJ stránky LEN oblasť s dostupnosťou TOHTO produktu. `null`
   * = oblasť sa nenašla. `url` (issue 241) je k dispozícii pre extraktory,
   * ktoré vedia krížovo overiť nájdenú oblasť proti ID/slugu SCRAPOVANÉHO
   * produktu (napr. `trigonaStockRegion`) — extraktor, ktorý takú kontrolu
   * nepotrebuje (má vlastnú štruktúrnu záruku inak, napr. CSS triedu), ho
   * jednoducho nemusí deklarovať vo svojej signatúre.
   */
  readonly extractRegion: (html: string, url: string) => string | null;
  /** Čo znamená CHÝBAJÚCA oblasť (žiadny štítok pri produkte). */
  readonly whenRegionMissing: SupplierAvailability;
}

/**
 * huntingshop.eu (issue 223): dostupnosť TOHTO produktu nesie `<span
 * class="badge badge-outline-…">` hneď pri cene. Karuselové štítky
 * súvisiacich produktov majú NAVYŠE triedu `badge-stock` — tie sa vylučujú,
 * inak by sa dostupnosť iného produktu v karuseli počítala za tento. Keď sa
 * nenájde ŽIADEN takýto štítok, produkt v skutočnosti nemá žiadnu značku
 * dostupnosti — to znamená `unavailable` (overené na vzorke: vypredaný
 * produkt štítok nemá vôbec), nikdy `available` z náhodného textu inde na
 * stránke (napr. pätičková veta „…máme skladom ihneď k odberu").
 */
function huntingshopDetailBadges(html: string): string | null {
  const spans = [...html.matchAll(/<span\b[^>]*class="([^"]*badge-outline-[^"]*)"[^>]*>([\s\S]*?)<\/span>/gi)];
  const texts = spans
    .filter(([, cls]) => cls !== undefined && !cls.includes("badge-stock"))
    .map(([, , text]) => (text ?? "").replace(/\s+/g, " ").trim())
    .filter((text) => text !== "");
  return texts.length > 0 ? texts.join(" ") : null;
}

const TRIGONA_STOCK_COUNT_RE =
  /<span\b[^>]*\bid="StockCountText(\d+)"[^>]*>\s*<span\b[^>]*\bstyle="[^"]*color:\s*(#[0-9a-fA-F]{6})[^"]*"[^>]*>/gi;
const TRIGONA_PRODUCT_ID_RE = /\/p-(\d+)\.xhtml/i;

/**
 * trigona.sk (issue 230, ID krížová kontrola issue 241): dostupnosť PRI
 * produkte nesie `<span id="StockCountText<ID>">` s vnoreným `<span
 * style="color: …">` — `<ID>` je ČÍSLO KONKRÉTNEHO produktu, ktoré sa MUSÍ
 * zhodovať s ID v URL (`.../p-<ID>.xhtml`), inak sa oblasť nepovažuje za
 * patriacu scrapovanému produktu. Predtým (issue 230) sa bral PRVÝ výskyt v
 * dokumente bez tejto kontroly — fungovalo to len vďaka empirickému dôkazu
 * (31 naživo overených stránok, vždy práve jeden výskyt), nie vďaka
 * štruktúrnej záruke. Keby trigona.sk niekedy pridala súvisiaci produkt s
 * rovnakou značkou VYŠŠIE na stránke, prvý-v-poradí by bol ISTO ZLÁ
 * odpoveď — preto sa teraz prechádzajú VŠETKY výskyty a vyberie sa ten,
 * ktorého `<ID>` sedí s URL.
 *
 * Farba rozhoduje o dostupnosti — obe polarity sú naživo overené proti
 * JSON-LD na TOM ISTOM produkte: `#00b020` (zelená, text "Na sklade")
 * zodpovedá JSON-LD `InStock`; `#024bbd` (modrá, text "1 - 4 týždne" —
 * dodacia lehota, nie doslovné slovo "vypredané") zodpovedá JSON-LD
 * `OutOfStock`. Farba sa prekladá na kanonické slovo, aby prešlo
 * existujúcim `availabilityFromText` zoznamom kľúčových slov.
 *
 * Nerozpoznaná farba, nerozobrateľné ID z URL, chýbajúci/nezhodný prvok,
 * ANI DVA zhodné-ID výskyty s ROZDIELNOU farbou (nejednoznačné, rovnaká
 * disciplína ako `matchSizeLabel`: viac než jedna zhoda sa počíta ako
 * žiadna) sa NEHÁDŽU na žiadnu stranu — vracia sa `null`
 * (`whenRegionMissing: "unknown"` nižšie). Na rozdiel od huntingshop.eu,
 * kde je naživo overené, že vypredaný produkt štítok vôbec nemá, sa na
 * trigona.sk medzi overenými vzorkami nikdy nevyskytla stránka bez tohto
 * prvku — preto tu niet dôkazu, čo by chýbajúci štítok znamenal.
 */
function trigonaStockRegion(html: string, url: string): string | null {
  const productId = TRIGONA_PRODUCT_ID_RE.exec(url)?.[1];
  if (productId === undefined) return null;
  const resolved = new Set<string>();
  for (const match of html.matchAll(TRIGONA_STOCK_COUNT_RE)) {
    const [, id, colorRaw] = match;
    if (id !== productId) continue;
    const color = (colorRaw ?? "").toLowerCase();
    if (color === "#00b020") resolved.add("skladom");
    else if (color === "#024bbd") resolved.add("vypredané");
  }
  const values = [...resolved];
  return values.length === 1 ? (values[0] ?? null) : null;
}

/**
 * virginiashop.sk/tenolix.cz/luko.cz (issue 227): rovnaká Shoptet šablóna,
 * jednoveľkostný produkt nesie `<span class="availability-label" ...
 * data-testid="labelAvailability">Skladom/Skladem/Momentálne(ě)
 * nedostupné</span>` — text sa vracia AKO JE a ide cez existujúci
 * `availabilityFromText` (žiadna nová farebná/triedová logika, na rozdiel od
 * trigona.sk). Naživo overené OBE polarity priamo na virginiashop.sk aj
 * tenolix.cz (rovnaká trieda, rovnaké farby #009901/#cb0000); luko.cz má
 * naživo overenú len zelenú vetvu — jej sledované odkazy sú takmer vždy
 * VIACVEĽKOSTNÉ produkty, ktoré tento `data-testid` vôbec nemajú (viď
 * `whenRegionMissing` nižšie), takže ostávajú `unknown` presne ako predtým.
 * Viacvariantový produkt (viac veľkostí/farieb naraz) tento `data-testid`
 * NEVYKRESĽUJE vôbec — vtedy sa nesmie nič uhádnuť z niektorej z viacerých
 * zhôd, preto `whenRegionMissing: "unknown"`.
 */
function shoptetLabelAvailability(html: string): string | null {
  const match = /<span\b[^>]*data-testid="labelAvailability"[^>]*>([\s\S]*?)<\/span>/i.exec(html);
  if (match === null) return null;
  const text = (match[1] ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

/**
 * fomei.com (issue 227): JSON-LD na stránke nie je Product/Offer (len
 * breadcrumb), ale schema.org MIKRODÁTA (`<span class="availability
 * availability--inStock|noStock">`) sa OPAKUJÚ naprieč stránkou — hlavný
 * produkt aj karusel "Súvisiace" nižšie majú ROVNAKÚ triedu (rovnaká
 * kolízia ako huntingshop.eu, issue 223). Preto sa hľadá LEN PRED nadpisom
 * "Súvisiace" (rovnaký "prvý patrí hlavnému produktu" princíp ako odimon.sk,
 * issue 225) a rozhoduje TRIEDA (`inStock`/`noStock`), nikdy viditeľný text
 * (ten sa medzi produktmi líši — "na dotaz" pri `noStock`). Neznáma trieda
 * ani chýbajúci prvok sa nikdy nehádaju na žiadnu stranu.
 */
function fomeiAvailabilityRegion(html: string): string | null {
  const relatedIndex = html.indexOf(">Súvisiace<");
  const scope = relatedIndex === -1 ? html : html.slice(0, relatedIndex);
  const match = /<span\b[^>]*class="[^"]*\bavailability--(inStock|noStock)\b[^"]*"[^>]*>/i.exec(scope);
  if (match === null) return null;
  const token = (match[1] ?? "").toLowerCase();
  if (token === "instock") return "skladom";
  if (token === "nostock") return "vypredané";
  return null;
}

const TEXT_AVAILABILITY_RULES: readonly TextAvailabilityRule[] = Object.freeze([
  { host: "huntingshop.eu", extractRegion: huntingshopDetailBadges, whenRegionMissing: "unavailable" },
  { host: "trigona.sk", extractRegion: trigonaStockRegion, whenRegionMissing: "unknown" },
  { host: "virginiashop.sk", extractRegion: shoptetLabelAvailability, whenRegionMissing: "unknown" },
  { host: "tenolix.cz", extractRegion: shoptetLabelAvailability, whenRegionMissing: "unknown" },
  { host: "luko.cz", extractRegion: shoptetLabelAvailability, whenRegionMissing: "unknown" },
  { host: "fomei.com", extractRegion: fomeiAvailabilityRegion, whenRegionMissing: "unknown" },
]);

function textAvailabilityRuleFor(url: string): TextAvailabilityRule | null {
  const host = hostOf(url);
  if (host === "") return null;
  return TEXT_AVAILABILITY_RULES.find((rule) => host === rule.host || host.endsWith(`.${rule.host}`)) ?? null;
}

interface VisibleAvailabilityHit {
  readonly availability: SupplierAvailability;
  readonly text: string;
}

interface VisibleAvailabilityRule {
  readonly host: string;
  readonly read: (html: string) => VisibleAvailabilityHit | null;
}

/**
 * odimon.sk (issue 225): JSON-LD tejto domény vie klamať (hlási "InStock",
 * hoci stránka pri produkte hovorí "Nedostupný"). `.product-availability__value`
 * PRI produkte je to, čo skutočne vidí zákazník — PRVÝ výskyt v dokumente
 * patrí hlavnému produktu (overené na vzorke: rovnaký prvok sa opakuje aj v
 * bloku súvisiacich produktov nižšie na stránke, ale až za hlavným).
 *
 * Token (`available`/`unavailable`, čo ROZHODUJE dostupnosť) sa berie z
 * TRIEDY vonkajšieho `<span>` — to je vždy spoľahlivé. Zobrazovaný text sa
 * ČÍTA EXPLICITNE z vnoreného `.product-availability__value--text`, nikdy sa
 * neodvodzuje z toho, kde náhodou skončí druhá zatváracia značka — tá by sa
 * mohla posunúť, keby stránka pridala ďalší vnorený prvok (napr. počet kusov).
 */
function odimonVisibleAvailability(html: string): VisibleAvailabilityHit | null {
  const outer =
    /<span\b[^>]*class="[^"]*product-availability__value--(available|unavailable)\b[^"]*"[^>]*>/i.exec(html);
  if (outer === null) return null;
  const token = outer[1];
  const rest = html.slice(outer.index + outer[0].length);
  const textMatch = /<span\b[^>]*class="[^"]*product-availability__value--text[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
    rest,
  );
  const text = (textMatch?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { availability: token === "available" ? "available" : "unavailable", text };
}

const VISIBLE_AVAILABILITY_RULES: readonly VisibleAvailabilityRule[] = Object.freeze([
  { host: "odimon.sk", read: odimonVisibleAvailability },
]);

function visibleAvailabilityFor(url: string, html: string): VisibleAvailabilityHit | null {
  const host = hostOf(url);
  if (host === "") return null;
  const rule = VISIBLE_AVAILABILITY_RULES.find((r) => host === r.host || host.endsWith(`.${r.host}`));
  return rule === undefined ? null : rule.read(html);
}

export interface SizeAvailability {
  /** Presný text veľkosti u DODÁVATEĽA (napr. "L/XL"), nie náš vlastný size_label. */
  readonly sizeLabel: string;
  readonly availability: "available" | "unavailable";
}

interface SizeAvailabilityRule {
  readonly host: string;
  readonly read: (html: string) => readonly SizeAvailability[];
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

const SIZE_AVAILABILITY_RULES: readonly SizeAvailabilityRule[] = Object.freeze([
  { host: "shop.lasting.eu", read: lastingSizeList },
  { host: "chiruca.sk", read: chirucaSizeList },
]);

function sizeAvailabilityRuleFor(url: string): SizeAvailabilityRule | null {
  const host = hostOf(url);
  if (host === "") return null;
  return SIZE_AVAILABILITY_RULES.find((rule) => host === rule.host || host.endsWith(`.${rule.host}`)) ?? null;
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

  if (jsonLd !== null) {
    return {
      availability: jsonLd.availability,
      availabilityText: jsonLd.token,
      price: jsonLd.price,
      source: "json_ld",
    };
  }

  const meta = fromMetaTags(html);
  if (meta !== null) {
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
