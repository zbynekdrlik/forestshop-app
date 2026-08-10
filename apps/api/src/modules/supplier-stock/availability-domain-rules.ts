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

import { availabilityFromText, decodeNumericEntities, hostOf, type SupplierAvailability } from "./availability-primitives.js";

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
 * virginiashop.sk/tenolix.cz/luko.cz/zubicek.cz (issue 227, issue 307):
 * rovnaká Shoptet šablóna, jednoveľkostný produkt nesie `<span
 * class="availability-label" ... data-testid="labelAvailability">Skladom/
 * Skladem/Momentálne(ě) nedostupné</span>` — text sa vracia AKO JE a ide cez
 * existujúci `availabilityFromText` (žiadna nová farebná/triedová logika, na
 * rozdiel od trigona.sk). Naživo overené OBE polarity priamo na
 * virginiashop.sk aj tenolix.cz (rovnaká trieda, rovnaké farby
 * #009901/#cb0000); luko.cz aj zubicek.cz majú naživo overenú len zelenú
 * vetvu — ich sledované odkazy sú z veľkej časti VIACVEĽKOSTNÉ produkty,
 * ktoré tento `data-testid` vôbec nemajú (viď `whenRegionMissing` nižšie),
 * takže ostávajú `unknown` presne ako predtým. Viacvariantový produkt (viac
 * veľkostí/farieb naraz) tento `data-testid` NEVYKRESĽUJE vôbec — vtedy sa
 * nesmie nič uhádnuť z niektorej z viacerých zhôd, preto
 * `whenRegionMissing: "unknown"`.
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

const VISIBLE_AVAILABILITY_RULES: readonly VisibleAvailabilityRule[] = Object.freeze([
  { host: "odimon.sk", read: odimonVisibleAvailability },
  { host: "lesona.sk", read: lesonaVisibleAvailability },
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
 * Používa `parsePage` (`parse.ts`): doména BEZ AKÉHOKOĽVEK pravidla
 * (presne prípad `roy.sk` — nie je ani v jednom zo zoznamov) nesmie dostať
 * `available` len zo strojového JSON-LD/meta údaju bez druhej kontroly —
 * fail-closed predvolený stav (`unknown`) namiesto dôvery naslepo. Domény
 * UŽ pokryté jedným z týchto pravidiel sa touto kontrolou nemenia — ich
 * správanie ostáva presné, aké je dnes (rozhodnutie zapísané na ticket-e).
 */
export function hasKnownAvailabilityRule(url: string): boolean {
  const host = hostOf(url);
  if (host === "") return false;
  const matches = (ruleHost: string): boolean => host === ruleHost || host.endsWith(`.${ruleHost}`);
  return TEXT_AVAILABILITY_RULES.some((rule) => matches(rule.host)) || VISIBLE_AVAILABILITY_RULES.some((rule) => matches(rule.host));
}
