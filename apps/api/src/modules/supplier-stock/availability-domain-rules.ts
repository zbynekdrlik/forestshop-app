// Per-doménový katalóg pravidiel pre voľný text (`TEXT_AVAILABILITY_RULES`) a
// viditeľnú dostupnosť (`VISIBLE_AVAILABILITY_RULES`) — vyčlenené z `parse.ts`
// (issue 307), aby ani jeden zo súborov neprerástol eslint `max-lines: 400`
// (`.claude/rules/testing.md`). `parse.ts` (generický algoritmus čítania
// stránky) a tento súbor (znalosť KONKRÉTNYCH dodávateľských domén) sú
// zámerne oddelené — nová doména sem pribudne bez toho, aby sa dotkla
// `parsePage`u samotného.
//
// Závisí LEN na `availability-primitives.ts` (nikdy na `parse.ts` priamo) —
// code review na issue 307 odhalil, že pôvodný import späť z `parse.ts` bol
// funkčne bezpečný, ale zbytočne cyklický import; `availability-
// primitives.ts` je spoločný jednosmerný základ pre oba súbory.

import {
  availabilityFromText,
  type CombinationTarget,
  decodeNumericEntities,
  hostOf,
  type SupplierAvailability,
} from "./availability-primitives.js";

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
 * virginiashop.sk/tenolix.cz/luko.cz/zubicek.cz/hunting24.cz/chocolenka.cz
 * (issue 227, issue 307, issue 332): rovnaká Shoptet šablóna, jednoveľkostný
 * produkt nesie `<span class="availability-label" ...
 * data-testid="labelAvailability">Skladom/Skladem/Momentálne(ě) nedostupné
 * </span>` — text sa vracia AKO JE a ide cez existujúci `availabilityFromText`
 * (žiadna nová farebná/triedová logika, na rozdiel od trigona.sk). Naživo
 * overené OBE polarity priamo na virginiashop.sk aj tenolix.cz (rovnaká
 * trieda, rovnaké farby #009901/#cb0000); luko.cz, zubicek.cz, hunting24.cz a
 * chocolenka.cz majú naživo overenú len zelenú vetvu — ich sledované odkazy
 * sú z veľkej časti VIACVEĽKOSTNÉ produkty, ktoré tento `data-testid` vôbec
 * nemajú (viď `whenRegionMissing` nižšie), takže ostávajú `unknown` presne
 * ako predtým. Viacvariantový produkt (viac veľkostí/farieb naraz) tento
 * `data-testid` NEVYKRESĽUJE vôbec — vtedy sa nesmie nič uhádnuť z niektorej
 * z viacerých zhôd, preto `whenRegionMissing: "unknown"`.
 *
 * Naživo overené, ĎALŠIA doména na tejto šablóne NEMÁ zaručene tú istú
 * šablónu verziu — werra.cz/soxland.sk/citrade.cz (issue 332) sú tiež
 * Shoptet, ale NOVŠIA šablóna tento `data-testid` VÔBEC nevykresľuje (má len
 * per-veľkostný `numberAvailabilityAmount` v selecte veľkostí, žiadny jeden
 * súhrnný text bez dohadu, ktorá veľkosť je "predvolená") — tie preto NIE SÚ
 * v zozname nižšie, zámerne.
 *
 * `title=`/`alt=` atribút sa stripuje PRED stripom tagov (issue 332, nález
 * pri overovaní chocolenka.cz): `data-testid="labelAvailability">` niekedy
 * obaľuje ĎALŠÍ vnorený `<span title="…dodacia poznámka…">Skladem</span>`
 * (tooltip) — pôvodný regex sa zastavil na PRVOM `</span>` (tomto vnorenom),
 * takže vrátený text niesol nezošmiznutý HTML tag CELÉHO vnoreného `<span>`
 * vrátane jeho `title=` hodnoty. Fungovalo to doteraz len náhodou (slovo
 * "Skladem" bolo súčasťou textu a tooltip neniesol žiadne kolízne kľúčové
 * slovo) — budúci tooltip s textom obsahujúcim napr. "nedostupné" by mohol
 * vyhrať namiesto skutočnej dostupnosti. `title=`/`alt=` MUSÍ zmiznúť PRED
 * `<[^>]+>` stripom, nie po ňom — hodnota tu vie niesť vlastný `<br />`,
 * ktorý by inak jednoduchý tag-strip rozdelil na dve časti uprostred
 * atribútu.
 */
function shoptetLabelAvailability(html: string): string | null {
  const match = /<span\b[^>]*data-testid="labelAvailability"[^>]*>([\s\S]*?)<\/span>/i.exec(html);
  if (match === null) return null;
  const text = (match[1] ?? "")
    .replace(/\s(?:title|alt)="[^"]*"/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? null : text;
}

const VRECKOVYNOZ_AVAILABILITY_RE =
  /<p\s+class=["']?product-detail__availability["']?>[\s\S]*?<span\s+class=["']?product-detail__code["']?>([\s\S]*?)<\/span>/i;

/**
 * vreckovynoz.sk (issue 332): hlavný produkt nesie dostupnosť v `<p
 * class=product-detail__availability> Dostupnosť: <span
 * class=product-detail__code>TEXT</span></p>` — BEZ úvodzoviek okolo triedy
 * v reálnom markupe (rovnaký jav ako rosler.sk, issue 307). Trieda
 * `product-detail__code` sa na stránke opakuje aj pre samotný KÓD produktu
 * ("7.8330") v SAMOSTATNOM predchádzajúcom `<p>` — regex je preto ukotvený
 * na `<p class=product-detail__availability>` PRED hľadaním vnoreného
 * `<span>`u, takže kódový span sa nikdy nezachytí. Súvisiace produkty v
 * karte nižšie na stránke majú ODLIŠNÚ triedu (`product-card__stock`), žiadna
 * kolízia (overené naživo — obe triedy koexistujú na stránke, presne raz
 * každá).
 *
 * Naživo overené 2× (2 rôzne produkty), obe "Skladom > N ks" — genuinný
 * vypredaný text sa nenašiel (rovnaká situácia ako rosler.sk/wetland.sk),
 * text ide cez existujúci `availabilityFromText`. Doména kóduje diakritiku
 * ako číselné HTML entity INDE na stránke (naživo overené `curl`om —
 * `&#x13E;`/`&#xE9;`/`&#x17E;`) — `decodeNumericEntities` sa preto aplikuje
 * defenzívne, presne ako rosler.sk (issue 307): v našich dvoch vzorkách sa
 * diakritika v SAMOTNOM dostupnostnom texte nevyskytla, ale budúci
 * "Vypredané" text by inak mohol ticho spadnúť na `unknown` namiesto
 * `unavailable`.
 */
function vreckovynozAvailability(html: string): string | null {
  const match = VRECKOVYNOZ_AVAILABILITY_RE.exec(html);
  if (match === null) return null;
  const text = decodeNumericEntities((match[1] ?? "").replace(/&gt;/gi, ">"))
    .replace(/\s+/g, " ")
    .trim();
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

const RAPPA_STOCK_RE = /<dt>Dostupnos.<\/dt>\s*<dd>\s*<span\b[^>]*class="([^"]*)"[^>]*>[\s\S]*?<\/span>/i;

/**
 * rappa.cz (issue 307): dostupnosť je v tabuľke parametrov ako `<dt>
 * Dostupnosť</dt><dd><span class="in-stock|out-of-stock">…</span></dd>` —
 * naživo overený JEDINÝ výskyt na stránke (žiadna karuselová kolízia ako
 * huntingshop.eu/fomei.com). Rozhoduje TRIEDA, nikdy text priamo — text nesie
 * aj počet kusov ("skladom (50 a viac ks)"), takže sa prekladá na kanonické
 * slovo ("skladom"/"vypredané") a ide cez existujúci `availabilityFromText`,
 * rovnaký vzor ako `trigonaStockRegion`. Obe polarity naživo overené
 * (7. 8. 2026, reálne produkty).
 *
 * Na rozdiel od `trigonaStockRegion` (prechádza VŠETKY výskyty, odmieta
 * nejednoznačnosť) tu žiadna obrana proti viacnásobnej zhode nie je — regex
 * berie PRVÝ (jediný, naživo overený) výskyt. Zámerné: pri ~20 naživo
 * overených produktoch sa opakovaný karuselový blok s rovnakým `<dt>
 * Dostupnosť</dt>` NENAŠIEL (code review na issue 307).
 */
function rappaStockRegion(html: string): string | null {
  const match = RAPPA_STOCK_RE.exec(html);
  if (match === null) return null;
  const classes = (match[1] ?? "").split(/\s+/);
  if (classes.includes("out-of-stock")) return "vypredané";
  if (classes.includes("in-stock")) return "skladom";
  return null;
}

const ROSLER_STOCK_DIV_RE = /<div\s+class=["']?product-detail-stock["']?>([\s\S]*?)<\/div>/i;

/**
 * rosler.sk (issue 307): dostupnosť PRI produkte je `<div
 * class=product-detail-stock>…</div>` (bez úvodzoviek v reálnom markupe) —
 * ODLIŠNÁ trieda od karuselových/súvisiacich položiek
 * (`product-thumb-stock`), žiadna kolízia; žiadna obrana proti viacnásobnej
 * zhode navyše nie je (rovnaká situácia ako `rappaStockRegion` — pri 20
 * naživo overených produktoch sa druhý výskyt tejto triedy nenašiel). Text
 * sa vracia AKO JE a ide cez existujúci `availabilityFromText`.
 *
 * `&#xHH;` číselné entity sa DEKÓDUJÚ (`decodeNumericEntities`), NIKDY sa
 * len nevyprázdňujú — code review na issue 307 odhalil, že táto doména
 * kóduje KAŽDÚ diakritiku takto ("dn&#xED;" = "dní", "ma&#xE1;" = "malá"),
 * takže vyprázdnenie by "vypredan&#xE9;" tichy zmenilo na "vypredan " a
 * extraktor by spadol na `unknown` namiesto `unavailable`.
 *
 * Naživo overené texty: "Skladom N ks" (available) a "Do 14 dní" (dodanie
 * na objednávku, nie skladom teraz) — druhý nezodpovedá žiadnemu slovu v
 * `IN_KEYWORDS`/`OUT_KEYWORDS`, preto correctně padá na `unknown`. Genuinný
 * vypredaný ("0 ks") text sa naživo NENAŠIEL napriek prehľadaniu 20
 * uložených odkazov + 3 kategórií — presne ako wetland.sk (issue 230):
 * pravidlo sa NEHÁDA, žiadne vlastné mapovanie "Do N dní" → unavailable sa
 * nepridáva (regresný fixtúrový test `rosler-vypredane-noz-entita.html`
 * overuje, že entitovo kódovaná diakritika v BUDÚCOM skutočnom vypredanom
 * texte teraz správne rozhoduje `unavailable`).
 */
function roslerStockRegion(html: string): string | null {
  const match = ROSLER_STOCK_DIV_RE.exec(html);
  if (match === null) return null;
  const text = decodeNumericEntities((match[1] ?? "").replace(/&gt;/gi, ">"))
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? null : text;
}

const TEXT_AVAILABILITY_RULES: readonly TextAvailabilityRule[] = Object.freeze([
  { host: "huntingshop.eu", extractRegion: huntingshopDetailBadges, whenRegionMissing: "unavailable" },
  { host: "trigona.sk", extractRegion: trigonaStockRegion, whenRegionMissing: "unknown" },
  { host: "virginiashop.sk", extractRegion: shoptetLabelAvailability, whenRegionMissing: "unknown" },
  { host: "tenolix.cz", extractRegion: shoptetLabelAvailability, whenRegionMissing: "unknown" },
  { host: "luko.cz", extractRegion: shoptetLabelAvailability, whenRegionMissing: "unknown" },
  { host: "zubicek.cz", extractRegion: shoptetLabelAvailability, whenRegionMissing: "unknown" },
  { host: "fomei.com", extractRegion: fomeiAvailabilityRegion, whenRegionMissing: "unknown" },
  { host: "rappa.cz", extractRegion: rappaStockRegion, whenRegionMissing: "unknown" },
  { host: "rosler.sk", extractRegion: roslerStockRegion, whenRegionMissing: "unknown" },
  { host: "hunting24.cz", extractRegion: shoptetLabelAvailability, whenRegionMissing: "unknown" },
  { host: "chocolenka.cz", extractRegion: shoptetLabelAvailability, whenRegionMissing: "unknown" },
  { host: "vreckovynoz.sk", extractRegion: vreckovynozAvailability, whenRegionMissing: "unknown" },
]);

export function textAvailabilityRuleFor(url: string): TextAvailabilityRule | null {
  const host = hostOf(url);
  if (host === "") return null;
  return TEXT_AVAILABILITY_RULES.find((rule) => host === rule.host || host.endsWith(`.${rule.host}`)) ?? null;
}

export interface VisibleAvailabilityHit {
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

// issue 549 — wetland.sk (PrestaShop 1.7/8). Otváracia značka detailového
// bloku nesie atribút s JSON zvolenej kombinácie (veľkosti). `id="product-…"`
// je ukotvené na presnú zatváraciu úvodzovku, takže sa nezhoduje s
// `id="product-…-heading"`/`-collapse` na tej istej stránke; hodnota atribútu
// je HTML-escapovaný JSON (žiadny doslovný `>` — všetky sú `&gt;`), takže
// `[^>]*` po úvodnej značke skončí až na skutočnom konci značky.
const WETLAND_PRODUCT_DETAILS_TAG_RE = /<div\b[^>]*\bid="product-details"[^>]*>/i;
const WETLAND_DATA_PRODUCT_RE = /\bdata-product="([\s\S]*?)"/i;

/**
 * HTML-unescape hodnoty atribútu (`htmlspecialchars(ENT_QUOTES)`, ktorý dáva
 * PrestaShop) späť na skutočný text PRED `JSON.parse`. `&amp;` sa nahrádza AKO
 * POSLEDNÉ — inak by `&amp;quot;` (doslovné `&quot;` v pôvodných dátach)
 * skončilo ako `"` a rozbilo JSON. Číselné entity toto pole reálne nenesie
 * (názvy/apostrofy idú cez `&#039;`), preto stačí týchto päť.
 */
function unescapeHtmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * wetland.sk (issue 549): PrestaShop s `allow_oosp:1` má pole `availability`
 * v `data-product` JSON aj CSS odznak `.success` KONŠTANTNE "available"/
 * skladom aj pre vypredaný tovar — preto sa pri issue 230 nenašiel overený
 * vypredaný príklad a doména ostala `unknown` (fail-closed, issue 330).
 * Živý rozbor 18. 9. 2026 našiel DVA rozhodujúce nezávislé signály:
 *   1. `data-product.quantity` (skladom 8 / vypredané 0) — PRIMÁRNY signál,
 *   2. JSON-LD `offers.availability` token (InStock ↔ quantity≥1,
 *      BackOrder/OutOfStock ↔ quantity≤0) — KRÍŽOVÁ kontrola.
 * Táto funkcia číta LEN quantity + `availability_message` (text pre appku);
 * NIKDY konštantné pole `availability` ani `.success` odznak. Krížovú kontrolu
 * proti JSON-LD robí `parsePage` (rovnaká VISIBLE_AVAILABILITY_RULES mechanika
 * ako odimon.sk, issue 225): pri rozpore quantity vs JSON-LD → `unknown`.
 *
 * `quantity ≥ 1` → available, `quantity ≤ 0` → unavailable. **Táto funkcia
 * NIKDY nevráti `null`** — pre wetland vždy rozhoduje quantity (primárny
 * signál), JSON-LD je len krížová kontrola (`parsePage`), NIKDY samotný zdroj
 * `available`. Keby sa vrátil `null`, `parsePage` by na tejto teraz-overenej
 * doméne (`knownDomain === true`) preskočil fail-closed bránu a uveril
 * SAMOTNÉMU JSON-LD `InStock` — presne ten falošný „skladom", ktorému má
 * issue 549 zabrániť, keby produktová stránka niekedy nevykreslila
 * product-details blok (drift šablóny) a JSON-LD by hlásil InStock (a JSON-LD
 * dodávateľa VIE klamať, viď odimon.sk/lesona.sk). Preto: chýbajúci/
 * nečitateľný blok ALEBO chýbajúce/nečíselné quantity → `unknown` hit
 * (fail-closed) — `parsePage` ho pri akomkoľvek JSON-LD tokene vyhodnotí ako
 * rozpor → `unknown`, nikdy `available`. Kategórie/404 (bez product-details)
 * tak tiež končia na `unknown`, čo je pre automatiku bezpečné (nič neprepne).
 * Kombináciu (veľkosť) vyberá prípona URL `-<id_product>-<id_product_attribute>`
 * (fáza 1 číta len veľkosť z uloženého odkazu; per-veľkosť enumerácia je fáza 2).
 */
/**
 * Prečítaná wetland kombinácia (issue 549 + 551). `availability` je
 * quantity-based (nikdy konštantné pole `availability`/`.success`), `text` je
 * `availability_message`, `attributeNames` sú názvy hodnôt VEĽKOSTNEJ skupiny
 * zvolenej kombinácie z `data-product.attributes` (`attributes[*].name` kde
 * `group` je „Veľkosť", napr. "39/40"; farba/odtieň sa vylúči) — prázdne, keď
 * produkt veľkostný atribút NEMÁ (jednoveľkostný produkt: pero, opasok, olej).
 */
export interface WetlandCombination {
  readonly availability: SupplierAvailability;
  readonly text: string;
  readonly attributeNames: readonly string[];
}

/** Normalizuje názov atribútovej skupiny na porovnanie bez diakritiky a bez
 * ohľadu na veľkosť písmen ("Veľkosť" → "velkost"). */
function normalizeAttributeGroup(value: unknown): string {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z]/g, "")
    : "";
}

/**
 * `true`, keď je atribútová skupina VEĽKOSŤ (sk „Veľkosť" / cz „Velikost").
 * Iba veľkostná skupina sa smie dostať do zoznamu kandidátov pre
 * `matchSizeLabel` — inak by názov FARBY/odtieňa („Limetka" → token
 * „LIMETKA") mohol cez prefixové párovanie sadnúť na našu krátku veľkosť
 * („L") a prepnúť veľkosť, ktorú stránka vôbec nezobrazila (code review issue
 * 551). Naživo overené 19. 9. 2026: wetland.sk modeluje KAŽDÚ farbu ako
 * SAMOSTATNÝ produkt (iné `id_product`), takže reálna kombinácia nesie len
 * veľkostný atribút — filter je obrana do hĺbky, nie riešenie pozorovaného
 * prípadu.
 */
function isWetlandSizeGroup(entry: Record<string, unknown>): boolean {
  const groups = [normalizeAttributeGroup(entry["group"]), normalizeAttributeGroup(entry["public_group"])];
  return groups.some((g) => g.startsWith("velkost") || g.startsWith("velikost"));
}

/** Názvy hodnôt VEĽKOSTNEJ skupiny zvolenej kombinácie z
 * `data-product.attributes` (`{ "1": { name, group } }`). Iné skupiny
 * (farba/odtieň) sa vylúčia (`isWetlandSizeGroup`). Prázdne pole = žiadny
 * veľkostný atribút (jednoveľkostný produkt bez `attributes`, alebo kombinácia
 * bez veľkostnej skupiny) → beh padne na blanket riadok. Kandidátny zoznam,
 * z ktorého `matchSizeLabel` (`parse.ts`) vyberie NAŠU zhodnú veľkosť —
 * rovnaká disciplína ako zoznam veľkostí u lasting/chiruca. */
function wetlandAttributeNames(raw: unknown): readonly string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const names: string[] = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (!isWetlandSizeGroup(entry)) continue;
    const name = entry["name"];
    if (typeof name === "string" && name.trim() !== "") names.push(name.trim());
  }
  return names;
}

/**
 * Jadro čítania wetland `data-product` (issue 549) rozšírené o názvy kombinácie
 * (issue 551). `wetlandVisibleAvailability` (blanket/no-size cesta) aj
 * `wetlandSizeList` (`parse.ts`, per-veľkosť cesta) ho zdieľajú. Chýbajúci/
 * nečitateľný blok alebo quantity → `unknown` (fail-closed, nikdy tichý ústup
 * na možno klamúci JSON-LD — pozri issue 549 obranu do hĺbky).
 */
/**
 * Vytiahne a rozparsuje `data-product` JSON z detailového bloku wetland
 * stránky. `null` = blok nie je / JSON sa nedá prečítať (fail-closed).
 * Zdieľané `readWetlandCombination` (dostupnosť + veľkosti) aj
 * `wetlandEnumerateCombinations`/`wetlandSuffixMismatch` (issue 552 —
 * potrebujú `id_product`/`id_product_attribute` z toho istého JSON-u).
 */
function parseWetlandDataProduct(html: string): Record<string, unknown> | null {
  const tag = WETLAND_PRODUCT_DETAILS_TAG_RE.exec(html);
  if (tag === null) return null;
  const dataProduct = WETLAND_DATA_PRODUCT_RE.exec(tag[0]);
  if (dataProduct === null) return null;
  try {
    const parsed: unknown = JSON.parse(unescapeHtmlAttr(dataProduct[1] ?? ""));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Product-details blok na stránke JE, len jeho JSON sa nedá prečítať —
    // fail-closed (`null`), nikdy tichý ústup na (možno klamúci) JSON-LD.
    return null;
  }
}

export function readWetlandCombination(html: string): WetlandCombination {
  const record = parseWetlandDataProduct(html);
  if (record === null) return { availability: "unknown", text: "", attributeNames: [] };
  const rawMessage = record["availability_message"];
  const text = typeof rawMessage === "string" ? rawMessage.trim() : "";
  const attributeNames = wetlandAttributeNames(record["attributes"]);
  const rawQuantity = record["quantity"];
  const quantity =
    typeof rawQuantity === "number"
      ? rawQuantity
      : typeof rawQuantity === "string" && rawQuantity.trim() !== ""
        ? Number(rawQuantity)
        : Number.NaN;
  if (!Number.isFinite(quantity)) return { availability: "unknown", text, attributeNames };
  return { availability: quantity >= 1 ? "available" : "unavailable", text, attributeNames };
}

function wetlandVisibleAvailability(html: string): VisibleAvailabilityHit {
  const { availability, text } = readWetlandCombination(html);
  return { availability, text };
}

/** Hodnotu `id_product`/`id_product_attribute` z `data-product` (číslo alebo
 * reťazec) na neprázdny reťazec, inak `""`. */
function idFieldToString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return "";
}

// issue 552 — enumerácia VŠETKÝCH kombinácií (veľkostí). Bázová stránka
// wetland.sk (PrestaShop) ukazuje LEN jednu kombináciu (z prípony odkazu),
// ale nesie `<select id="group_1" name="group[N]">` so VŠETKÝMI veľkosťami
// (`<option value="<id_attribute>">názov`) a `id_product` v `data-product`.
// Pre každú veľkosť sa poskladá PrestaShop `action=refresh` GET (naživo
// overené 18. 9. 2026: plain GET bez cookies/XHR hlavičky), ktorý vráti JSON
// s `product_details` pre POŽADOVANÚ veľkosť. `name="group[N]"` nesie číslo
// skupiny N (nemusí byť 1) — berie sa priamo z markupu, nie natvrdo.
const WETLAND_GROUP_SELECT_RE = /<select\b[^>]*\bname="group\[(\d+)\]"[^>]*>([\s\S]*?)<\/select>/i;
const WETLAND_OPTION_RE = /<option\b[^>]*\bvalue="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;

/**
 * URL na `action=refresh` per VEĽKOSŤ z bázovej wetland stránky (issue 552).
 * Prázdny zoznam, keď stránka nemá `id_product` alebo veľkostný `<select>`
 * (jednoveľkostný produkt — enumerácia sa preskočí, ostáva plošný riadok
 * fázy 1). `link` sa zbaví prípadného query stringu pred zložením URL.
 * Duplicitné `id_attribute` sa preskočia (nikdy dva rovnaké requesty).
 */
export function wetlandEnumerateCombinations(html: string, link: string): readonly CombinationTarget[] {
  const record = parseWetlandDataProduct(html);
  if (record === null) return [];
  const idProduct = idFieldToString(record["id_product"]);
  // `id_product`/`id_attribute` sú v PrestaShope VŽDY číselné — vpisujú sa
  // NEescapované do refresh URL, takže sa gatujú na `\d+` (code review 🔵, issue
  // 552). Nejde o SSRF (`base` je z NÁŠHO uloženého odkazu, host sa nemení),
  // ale kompromitovaná dodávateľská stránka by inak vedela vpísať `&`/medzeru a
  // znečistiť query parametre — nečíselnú hodnotu radšej preskočíme.
  if (!/^\d+$/.test(idProduct)) return [];
  const selectMatch = WETLAND_GROUP_SELECT_RE.exec(html);
  if (selectMatch === null) return [];
  const groupNum = selectMatch[1] ?? "";
  const optionsHtml = selectMatch[2] ?? "";
  const base = link.split("?")[0] ?? link;
  const targets: CombinationTarget[] = [];
  const seen = new Set<string>();
  for (const [, idAttributeRaw, rawLabel] of optionsHtml.matchAll(WETLAND_OPTION_RE)) {
    const idAttribute = (idAttributeRaw ?? "").trim();
    if (!/^\d+$/.test(idAttribute) || seen.has(idAttribute)) continue;
    seen.add(idAttribute);
    const label = decodeNumericEntities(rawLabel ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const url = `${base}?ajax=1&action=refresh&id_product=${idProduct}&group[${groupNum}]=${idAttribute}&quantity_wanted=1`;
    targets.push({ url, label });
  }
  return targets;
}

/**
 * Rozbalí PrestaShop `action=refresh` JSON odpoveď na HTML `product_details`
 * (blok s `data-product` požadovanej kombinácie), ktoré potom číta zdieľané
 * `readWetlandCombination`/`wetlandSizeList` (znovupoužitie parsera, bez
 * forku). Nevalidný JSON / chýbajúce `product_details` → prázdny reťazec →
 * `readWetlandCombination` vráti `unknown` (fail-closed). Odpoveď NEMÁ JSON-LD
 * (naživo overené), takže per-veľkosť quantity je primárny signál a JSON-LD
 * krížová kontrola ostáva len na bázovej stránke (predvolená kombinácia).
 */
export function unwrapWetlandCombinationResponse(rawResponse: string): string {
  try {
    const parsed: unknown = JSON.parse(rawResponse);
    if (typeof parsed === "object" && parsed !== null) {
      const details = (parsed as Record<string, unknown>)["product_details"];
      if (typeof details === "string") return details;
    }
  } catch {
    // Nevalidný JSON → prázdny HTML → fail-closed `unknown`.
  }
  return "";
}

const WETLAND_SUFFIX_RE = /-(\d+)-(\d+)(?:[/?#]|$)/;

/**
 * Nesúlad medzi `id_product_attribute` v prípone ULOŽENÉHO odkazu
 * (`-<id_product>-<ipa>`) a kombináciou, ktorú bázová stránka reálne
 * vyrenderovala (issue 552). Zastaraná prípona (napr. zrušená veľkosť) sa
 * na wetland.sk 301-presmeruje na PREDVOLENÚ kombináciu, takže fáza 1 mohla
 * hlásiť sklad CUDZEJ veľkosti — `run.ts` tento nesúlad zaloguje ako
 * varovanie (enumerácia zo `<select>` je proti tomu imúnna, číta všetky
 * veľkosti nanovo). `null` = prípona sedí, nie je prípona, alebo stránka
 * nemá kombináciu (ipa 0/chýba).
 */
export function wetlandSuffixMismatch(
  html: string,
  link: string,
): { readonly expected: string; readonly actual: string } | null {
  const record = parseWetlandDataProduct(html);
  if (record === null) return null;
  const actual = idFieldToString(record["id_product_attribute"]);
  if (actual === "" || actual === "0") return null;
  const expected = WETLAND_SUFFIX_RE.exec(link)?.[2];
  if (expected === undefined) return null;
  return expected === actual ? null : { expected, actual };
}

const LESONA_AVAILABILITY_RE = /<span\b[^>]*\bid="product-availability"[^>]*>([\s\S]*?)<\/span>/i;

/**
 * lesona.sk (issue 307): stránkové schema.org mikrodáta
 * (`<link itemprop="availability" href="https://schema.org/InStock">`) VEDIA
 * KLAMAŤ — presne ako odimon.sk (issue 225). Naživo overené na reálnom
 * produkte (slúchadlá 3M Peltor, id 58): mikrodáta tvrdia `InStock`, ale
 * viditeľný `<span id="product-availability">` s ikonkou
 * `product-unavailable` hovorí "Vypredané" a tlačidlo "Vložiť do košíka" je
 * `disabled`. Táto appka mikrodáta vôbec neparsuje (`fromJsonLd` hľadá len
 * `<script type="application/ld+json">`, `fromMetaTags` len `<meta
 * property="og:…"/"product:…">` — ani jedno túto `itemprop=` mikrodátovú
 * formu nezachytí, takže pre lesona.sk je `jsonLd` v `parsePage` VŽDY
 * `null` — nejde teda o AKTÍVNE krížové overenie proti JSON-LD ako pri
 * odimon.sk, len o to, že sa mikrodátam nikdy nedôveruje), namiesto toho sa
 * dostupnosť číta VÝHRADNE z tohto viditeľného `<span>`.
 *
 * Naživo overené TRI stavy: prázdny span (nič v ňom, plne skladom), ikonka
 * `product-unavailable` + text "Vypredané" (nedostupné), ikonka
 * `product-last-items` + "Posledné kusy v sklade" (skladom, málo kusov — už
 * v `IN_KEYWORDS`). `decodeNumericEntities` odstraňuje ikonkové Material-
 * Icons kódové body (Private Use Area, napr. `&#xE14B;`) rovnakou funkciou
 * ako `roslerStockRegion` dekóduje diakritiku — dekódovaný PUA znak sa
 * nezhoduje so žiadnym slovom v `IN_KEYWORDS`/`OUT_KEYWORDS`, rovnaký
 * výsledný efekt ako predošlé vyprázdnenie. Nerozpoznaný NEPRÁZDNY text sa
 * vracia ako `"unknown"` (nie `null`) — keby sa niekedy pridalo skutočné
 * JSON-LD, `null` by nechalo (možno klamúce) JSON-LD rozhodnúť namiesto
 * tohto overeného viditeľného zdroja; `"unknown"` to zaručene nedovolí
 * (`parsePage`'s konfliktová kontrola).
 */
function lesonaVisibleAvailability(html: string): VisibleAvailabilityHit | null {
  const match = LESONA_AVAILABILITY_RE.exec(html);
  if (match === null) return null;
  const text = decodeNumericEntities((match[1] ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return { availability: "available", text: "" };
  const { availability, matched } = availabilityFromText(text);
  return { availability, text: matched };
}

// issue 557 — grube.de / grube.sk (vlastná platforma Grube). Dostupnosť žije v
// JSON-LD `Product.offers`: buď jeden `Offer`, alebo `AggregateOffer.offers[]`
// (VŠETKY veľkosti/farby v jednom GET). Per ponuka: `name` (napr. „Farbe
// grün-orange. Größe 3XL."), `availability` (schema.org InStock/BackOrder/
// SoldOut) a `inventoryLevel.value`. Veľkosť = token za „Größe"; ponuka bez
// „Größe" (jednoveľkostný produkt = jeden Offer) je blanket. Text „auf Lager"
// na stránke je šablónový šum (desiatky výskytov aj na vypredanej stránke) —
// číta sa VÝHRADNE JSON-LD, nikdy viditeľný text.
export interface GrubeOffer {
  /** Token za „Größe" z `name` (napr. „3XL"), alebo `null` keď ponuka veľkosť nenesie. */
  readonly sizeLabel: string | null;
  /** InStock A inventoryLevel.value ≥ 1 → available; BackOrder/SoldOut/inv 0 → unavailable. */
  readonly availability: "available" | "unavailable";
}

const GRUBE_SIZE_RE = /Größe\s+([^.\s]+)/i;

/** `inventoryLevel.value` (číslo alebo číselný reťazec) na číslo, inak `NaN`. */
function grubeInventoryValue(offer: Record<string, unknown>): number {
  const level = offer["inventoryLevel"];
  if (typeof level !== "object" || level === null) return Number.NaN;
  const raw = (level as Record<string, unknown>)["value"];
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") return Number(raw);
  return Number.NaN;
}

/** Rozhodne dostupnosť JEDNEJ ponuky: available LEN keď je token InStock A
 * inventoryLevel.value ≥ 1 (BackOrder/SoldOut aj „InStock ale 0 kusov" =
 * unavailable). Bezpečný smer: nečitateľná ponuka → unavailable (nikdy
 * neprepne náš produkt na Skladom). */
function grubeOfferAvailability(offer: Record<string, unknown>): "available" | "unavailable" {
  const rawAvail = offer["availability"];
  const token = typeof rawAvail === "string" ? (rawAvail.split("/").pop() ?? "").toLowerCase() : "";
  const inventory = grubeInventoryValue(offer);
  return token === "instock" && Number.isFinite(inventory) && inventory >= 1 ? "available" : "unavailable";
}

/** Zoznam ponúk z JSON-LD `Product.offers` (jeden `Offer`, `AggregateOffer.offers[]`
 * alebo pole `offers[]`). Prechádza VŠETKY ld+json bloky a VŠETKY Product uzly. */
export function grubeOffers(html: string): readonly GrubeOffer[] {
  const result: GrubeOffer[] = [];
  const pushOffer = (offer: unknown): void => {
    if (typeof offer !== "object" || offer === null) return;
    const record = offer as Record<string, unknown>;
    const name = record["name"];
    const sizeMatch = typeof name === "string" ? GRUBE_SIZE_RE.exec(name) : null;
    result.push({
      sizeLabel: sizeMatch === null ? null : (sizeMatch[1] ?? "").trim() || null,
      availability: grubeOfferAvailability(record),
    });
  };
  const readProduct = (node: Record<string, unknown>): void => {
    const offers = node["offers"];
    if (Array.isArray(offers)) {
      for (const offer of offers) pushOffer(offer);
    } else if (typeof offers === "object" && offers !== null) {
      const sub = (offers as Record<string, unknown>)["offers"];
      if (Array.isArray(sub)) for (const offer of sub) pushOffer(offer);
      else pushOffer(offers);
    }
  };
  // Code review issue 557 (🔵): pozbierajú sa Product uzly v poradí dokumentu a
  // ponuky sa čítajú LEN z PRVÉHO (hlavný produkt). grube stránky nesú práve jeden
  // `@type:Product` (naživo overené 2026-09-18 na 3 stránkach — druhý ld+json blok je
  // BreadcrumbList), ale keby niekedy pribudol Product uzol súvisiaceho produktu
  // (blok „Podobné"), jeho ponuky by inak mohli vpísať CUDZIE veľkosti do
  // `grubeSizeList` — ukotvenie na prvý Product to uzavrie (dedup by rozpor zahodil =
  // fail-closed, ale extra nekolízna veľkosť by prešla). Rovnaká „prvý patrí hlavnému
  // produktu" disciplína ako odimon/fomei.
  const isProductNode = (record: Record<string, unknown>): boolean => {
    const type = record["@type"];
    return (
      (typeof type === "string" && type.toLowerCase().includes("product")) ||
      (Array.isArray(type) && type.some((t) => typeof t === "string" && t.toLowerCase().includes("product")))
    );
  };
  const products: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (isProductNode(record)) {
      products.push(record); // Product uzol sa nerozbaľuje ďalej — jeho `offers` číta readProduct
      return;
    }
    for (const value of Object.values(record)) walk(value);
  };
  for (const block of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = block[1];
    if (body === undefined) continue;
    try {
      walk(JSON.parse(body));
    } catch {
      // Nevalidný JSON-LD sa preskočí, nikdy nezhodí beh (rovnako ako `fromJsonLd`).
    }
  }
  const mainProduct = products[0];
  if (mainProduct !== undefined) readProduct(mainProduct);
  return result;
}

/**
 * grube blanket cesta (jednoveľkostný produkt = jeden `Offer` bez „Größe"). Keď
 * má stránka PRÁVE JEDNU ponuku → jej dostupnosť; viac ponúk (viacveľkostný
 * produkt, kde náš variant nemá veľkosť) alebo žiadna → `unknown` (fail-closed,
 * nikdy dohad z prvej ponuky). NIKDY nevracia `null` — grube JE overená doména
 * (`knownDomain`), takže `null` by nechal `parsePage` uveriť samotnému JSON-LD
 * (rovnaká obrana ako `wetlandVisibleAvailability`). Per-veľkosť čítanie je v
 * `SIZE_AVAILABILITY_RULES` (`parse.ts`, `grubeSizeList`).
 */
export function grubeVisibleAvailability(html: string): VisibleAvailabilityHit {
  const offers = grubeOffers(html);
  if (offers.length === 1 && offers[0] !== undefined) {
    return { availability: offers[0].availability, text: "" };
  }
  return { availability: "unknown", text: "" };
}

const PYRA_POSTID_RE = /<body\b[^>]*\bclass="[^"]*\bpostid-(\d+)\b[^"]*"/i;

/**
 * pyra.eu (+ vo.pyra.eu) — WooCommerce / XStore (issue 559). Hlavný produkt sa
 * identifikuje cez `postid-<id>` v `<body class>`; jeho dostupnosť je TOKEN v
 * triede elementu s `post-<id>` (`instock` / `outofstock` / `onbackorder`).
 * NIKDY sa nečíta `p.stock` „Na sklade" (na vypredanej stránke 10× zo súvisiacich
 * produktov) ani cudzie `post-<iné id>` triedy — ukotvenie na `postId` z body je
 * to, čo odlíši hlavný produkt od súvisiacich. Krížovú kontrolu proti JSON-LD robí
 * `parsePage` (VISIBLE mechanika, rozpor → `unknown`).
 *
 * NIKDY nevracia `null` (rovnaká obrana ako `wetlandVisibleAvailability`/
 * `grubeVisibleAvailability`): pyra JE overená doména (`knownDomain`) a MÁ JSON-LD,
 * takže `null` by nechal `parsePage` uveriť samotnému (možno klamúcemu) JSON-LD —
 * chýbajúci postid / prvok / nerozpoznaný token vracia `unknown`.
 */
function pyraVisibleAvailability(html: string): VisibleAvailabilityHit {
  const postId = PYRA_POSTID_RE.exec(html)?.[1];
  if (postId === undefined) return { availability: "unknown", text: "" };
  // `postId` je čisto číselný (`\d+`), takže jeho vloženie do RegExp je bezpečné.
  const classMatch = new RegExp(`class="([^"]*\\bpost-${postId}\\b[^"]*)"`, "i").exec(html);
  if (classMatch === null) return { availability: "unknown", text: "" };
  const tokens = (classMatch[1] ?? "").split(/\s+/);
  if (tokens.includes("instock")) return { availability: "available", text: "instock" };
  if (tokens.includes("outofstock")) return { availability: "unavailable", text: "outofstock" };
  if (tokens.includes("onbackorder")) return { availability: "unavailable", text: "onbackorder" };
  return { availability: "unknown", text: "" };
}

const VISIBLE_AVAILABILITY_RULES: readonly VisibleAvailabilityRule[] = Object.freeze([
  { host: "odimon.sk", read: odimonVisibleAvailability },
  { host: "lesona.sk", read: lesonaVisibleAvailability },
  { host: "wetland.sk", read: wetlandVisibleAvailability },
  // issue 556: tthunt.sk je tá istá PrestaShop 1.7/8 šablóna ako wetland.sk
  // (`<div id="product-details" data-product="…">` s `quantity` + `attributes`,
  // pole `availability` KONŠTANTNE "available" pri `allow_oosp:1`) — číta sa
  // rovnakým `wetlandVisibleAvailability` (quantity + krížová kontrola JSON-LD
  // robí `parsePage`). Blanket cesta pre jednoveľkostné tthunt produkty; per-veľkosť
  // je v `SIZE_AVAILABILITY_RULES` (`parse.ts`). Naživo overené 2026-09-18.
  { host: "tthunt.sk", read: wetlandVisibleAvailability },
  // issue 557: grube.de/grube.sk blanket cesta (jeden Offer bez „Größe") —
  // per-veľkosť je v `SIZE_AVAILABILITY_RULES`. VISIBLE záznam robí grube
  // overenou doménou (`knownDomain`), takže jednoveľkostný produkt (companion
  // nôž) dostane `available` z JSON-LD, nie fail-closed `unknown` (issue 330).
  { host: "grube.de", read: grubeVisibleAvailability },
  { host: "grube.sk", read: grubeVisibleAvailability },
  // issue 559: pyra.eu (aj vo.pyra.eu cez sufix match). WooCommerce class token.
  { host: "pyra.eu", read: pyraVisibleAvailability },
]);

export function visibleAvailabilityFor(url: string, html: string): VisibleAvailabilityHit | null {
  const host = hostOf(url);
  if (host === "") return null;
  const rule = VISIBLE_AVAILABILITY_RULES.find((r) => host === r.host || host.endsWith(`.${r.host}`));
  return rule === undefined ? null : rule.read(html);
}

/**
 * `true`, keď doména (alebo jej poddoména) MÁ vlastné pravidlo — viditeľné
 * (`VISIBLE_AVAILABILITY_RULES`) ALEBO textové (`TEXT_AVAILABILITY_RULES`) —
 * teda keď sa preň niekedy spravila AKÁKOĽVEK overovacia práca (issue 330).
 * Volá ju `parsePage` (`parse.ts`): doména BEZ AKÉHOKOĽVEK pravidla (presne
 * prípad `roy.sk` — nie je ani v jednom zo zoznamov) nesmie dostať
 * `available` len zo strojového JSON-LD/meta údaju bez druhej kontroly —
 * fail-closed predvolený stav (`unknown`) namiesto dôvery naslepo. Domény
 * UŽ pokryté jedným z týchto pravidiel sa touto kontrolou nemenia — ich
 * správanie ostáva presné, aké je dnes (rozhodnutie zapísané na ticket-e).
 *
 * Textová polovica zámerne znovu POUŽÍVA `textAvailabilityRuleFor` (čistá,
 * len na `url` závislá funkcia) namiesto vlastného porovnávania — viditeľná
 * polovica to urobiť NEMÔŽE (`visibleAvailabilityFor` závisí aj na `html` a
 * vracia `null` aj keď doména pravidlo MÁ, len sa na TEJTO konkrétnej
 * stránke nenašla zhoda — to by tu znamenalo mylné "doména bez pravidla").
 */
export function hasKnownAvailabilityRule(url: string): boolean {
  if (textAvailabilityRuleFor(url) !== null) return true;
  const host = hostOf(url);
  if (host === "") return false;
  return VISIBLE_AVAILABILITY_RULES.some((rule) => host === rule.host || host.endsWith(`.${rule.host}`));
}
