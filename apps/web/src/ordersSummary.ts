import { NEZNAMY_DODAVATEL, type OrderLine } from "./ordersApi.js";

// issue 61 — priamy náprotivok starej appky's `isHandled` (`ORDERED[o.key] ||
// WAITING[o.key] || INSTOCK[o.key] || UNAVAIL[o.key]`, `app.js:2332-2498`).
// Nová appka nemá štyri nezávislé boolean mapy — má `order_line.ordered`
// (issue 60, náprotivok ORDERED) a `order_line.state` (náprotivok WAITING/
// INSTOCK/UNAVAIL, kde predvolené "objednane" = nič z toho troch). Riadok je
// teda "vybavený" presne vtedy, keď je odškrtnutý ako objednané ALEBO jeho
// stav postúpil za predvolený "objednane" (`.claude/rules/orders.md`).
export function isLineResolved(line: Pick<OrderLine, "ordered" | "state">): boolean {
  return line.ordered || line.state !== "objednane";
}

// issue 149 — jediné miesto rozhodujúce, či "skryť vybavené" riadok SKUTOČNE
// skryje. Zdieľané medzi `OrdersSection.tsx`'s `visibleLinesCount` (hláška
// "Všetko vybavené") a `SupplierOrderGroup.tsx`'s `visibleLines` (skutočné
// vykreslenie) — výnimka je rovnaká na oboch miestach: vybavený riadok s
// PRÁVE TERAZ otvorenou/rozpísanou úpravou (`dirtyEditorLineIds`,
// `useDirtyEditorLineIds.ts`) ostáva viditeľný, kým sa úprava nezavrie.
export function isLineHiddenByFilter(
  line: Pick<OrderLine, "ordered" | "state" | "lineId">,
  hideResolved: boolean,
  dirtyEditorLineIds: ReadonlySet<string>,
): boolean {
  return hideResolved && isLineResolved(line) && !dirtyEditorLineIds.has(line.lineId);
}

// issue 260: každé pole je súčet `quantity` (počet KUSOV naprieč riadkami),
// nikdy počet riadkov — pozri `summarizeOrderLines`'s komentár nižšie.
export interface OrderLinesSummary {
  readonly total: number;
  readonly remaining: number;
  readonly ordered: number;
  readonly waiting: number;
  readonly stock: number;
  readonly unavailable: number;
}

/**
 * issue 260 (majiteľ: "sú tam 2 rovnaké čelovky, ale ukazuje len jednu"):
 * KAŽDÉ pole tu je súčet `quantity` (počet KUSOV), NIE počet riadkov.
 * `ingest.ts` sčíta ten istý produkt v tej istej objednávke do JEDNÉHO
 * `order_line` s `quantity > 1` (`.claude/rules/orders.md`) — počítanie
 * riadkov (`lines.length`/`+= 1`) preto podčíta presne v tomto prípade:
 * dva kusy na jednom riadku by vyšli ako "1". Výnimka: `OrdersSection.tsx`'s
 * nav-odznak (issue 147) zámerne NEPOUŽÍVA túto funkciu — jeho vlastný,
 * samostatne zdokumentovaný zámer je počet NEVYBAVENÝCH RIADKOV, nie kusov.
 *
 * Rozpis NIE JE rozklad `total` na disjunktné časti — jeden riadok môže byť
 * súčasne `ordered` AJ v inom stave než "objednane" (rovnaký zámer ako stará
 * appka's `toOrderSummary`, ktorej komentár to hovorí výslovne: "the
 * breakdown is not a partition of total"). `remaining` sa preto počíta
 * priamo cez `isLineResolved`, nikdy odčítaním súčtu rozpisu od `total`.
 */
export function summarizeOrderLines(
  lines: readonly Pick<OrderLine, "ordered" | "state" | "quantity">[],
): OrderLinesSummary {
  let ordered = 0;
  let waiting = 0;
  let stock = 0;
  let unavailable = 0;
  let remaining = 0;
  let total = 0;
  for (const line of lines) {
    total += line.quantity;
    if (line.ordered) ordered += line.quantity;
    if (line.state === "caka_sa") waiting += line.quantity;
    if (line.state === "skladom") stock += line.quantity;
    if (line.state === "nedostupne") unavailable += line.quantity;
    if (!isLineResolved(line)) remaining += line.quantity;
  }
  return { total, remaining, ordered, waiting, stock, unavailable };
}

const BREAKDOWN_PARTS: readonly (readonly ["ordered" | "waiting" | "stock" | "unavailable", string])[] = [
  ["ordered", "Objednané"],
  ["waiting", "Čaká sa"],
  ["stock", "Skladom"],
  ["unavailable", "Nedostupné"],
];

// `supplierLabel` = `null` pre "Všetci" (žiadny chip vybraný), inak meno
// vybraného dodávateľa (vrátane zástupného "(bez dodávateľa)").
export function formatOrderSummaryText(summary: OrderLinesSummary, supplierLabel: string | null): string {
  const head = supplierLabel !== null ? `${supplierLabel}: ostáva vybaviť` : "Ostáva vybaviť";
  const bits = BREAKDOWN_PARTS.filter(([key]) => summary[key] > 0).map(
    ([key, label]) => `${label} ${String(summary[key])}`,
  );
  return (
    `${head} ${String(summary.remaining)} z ${String(summary.total)}` +
    (bits.length > 0 ? ` · ${bits.join(" · ")}` : "")
  );
}

// issue 452 (šéfov kolega Štěpán, Discord 19.8.2026: "aby tie jednotlivé firmy
// ktoré sa zobrazujú hore farebne ... boli radené za sebou podľa abecedy") —
// dodávateľské čipy v hlavičke "Na objednanie" (`OrdersToolbar.tsx`) sa
// vykresľovali v poradí, aké príde z API (`queries.ts` triedi podľa NAJNOVŠEJ
// objednávky skupiny, nie abecedne), v čom sa majiteľ ťažko orientoval. Táto
// čisto prezentačná funkcia vráti NOVÉ pole skupín zoradené abecedne pre
// vykreslenie čipov — vstupné `suppliers` sa NEMENÍ (iné miesta appky spoliehajú
// na pôvodné poradie/identitu, a súčty čipov sú od poradia nezávislé).
//
// `sensitivity: "accent"` = case-insensitive (BETALOV == betalov PRI RADENÍ), ale
// diakritika sa ROZLIŠUJE, takže slovenské poradie (c < č < d, s < š) ostáva
// správne. Zástupný kôš `NEZNAMY_DODAVATEL` ("(bez dodávateľa)") ostáva VŽDY
// NAPOSLEDY — rovnako ako už dnes robí `queries.ts` (aNull/bNull) aj zoznam
// skupín pod čipmi; nie je to firma, takže sa medzi ne neradí. Čip "Všetci" nie
// je skupina (vykresľuje sa samostatne, vždy prvý), teda sa tejto funkcie netýka.
export function sortSuppliersForChips<T extends { readonly supplier: string }>(
  suppliers: readonly T[],
): readonly T[] {
  return [...suppliers].sort((a, b) => {
    const aNull = a.supplier === NEZNAMY_DODAVATEL;
    const bNull = b.supplier === NEZNAMY_DODAVATEL;
    if (aNull !== bNull) return aNull ? 1 : -1;
    return a.supplier.localeCompare(b.supplier, "sk", { sensitivity: "accent" });
  });
}

// issue 62 — priamy náprotivok starej appky's `groupQtyTotals`/`totalChipSpec`
// (`app.js:1918-1962`). Kľúčované podľa `variantCode` (ten už v sebe nesie aj
// veľkosť, `.claude/rules/orders.md`), počítané nad CELOU (nefiltrovanou)
// množinou riadkov jedného dodávateľa — volajúci VŽDY posiela
// `group.lines`, nikdy pohľad zúžený prepínačom "skryť vybavené", aby chip
// nezávisel od toho prepínača (rovnaký zámer ako stará appka's komentár
// "same outstandingOf scope").
export interface VariantTotal {
  readonly total: number;
  readonly remaining: number;
  readonly lineCount: number;
}

export function computeVariantTotals(
  lines: readonly Pick<OrderLine, "variantCode" | "quantity" | "ordered" | "state">[],
): ReadonlyMap<string, VariantTotal> {
  const totals = new Map<string, { total: number; remaining: number; lineCount: number }>();
  for (const line of lines) {
    const entry = totals.get(line.variantCode) ?? { total: 0, remaining: 0, lineCount: 0 };
    entry.total += line.quantity;
    if (!isLineResolved(line)) entry.remaining += line.quantity;
    entry.lineCount += 1;
    totals.set(line.variantCode, entry);
  }
  return totals;
}

// Chip sa zobrazí LEN keď produkt genuinely opakuje naprieč VIACERÝMI
// riadkami dodávateľa (`lineCount >= 2`, rovnaká podmienka ako stará appka's
// `all.lines < 2` → žiadny chip) — jediný riadok produktu by chip len
// zopakoval množstvo, ktoré je už vidno v stĺpci vedľa. issue 63 (nález pri
// kontrole issue 62): rovnako sa chip schová, keď `remaining === 0` — celý
// opakovaný produkt je UŽ vybavený naprieč všetkými riadkami, chip by inak
// navždy visel s textom "Σ spolu 0 ks" aj keď netreba nič objednať.
export function formatVariantTotalChip(vt: VariantTotal): { readonly text: string; readonly title: string } | null {
  if (vt.lineCount < 2 || vt.remaining === 0) return null;
  return {
    // issue 204: text skrátený zo "Σ spolu N ks" na "Σ N ks" — dlhší tvar sa
    // do 54px stĺpca s množstvom nezmestil ani po zalomení pod množstvo
    // (nameraných 82px obsahu), takže pretekal do susedného stĺpca.
    // issue 214: ani "Σ N ks" sa nezmestilo — na produkcii nameraných 49 px
    // obsahu proti 16 px zobrazeným, takže `text-overflow: ellipsis` pilulku
    // orezal na "Σ…" na KAŽDEJ šírke okna a majiteľ z nej nič neprečítal.
    // Jednotka odpadá: riadok priamo NAD pilulkou už hovorí "N ks", takže
    // "Σ 3" sa číta ako "spolu 3". Celé vysvetlenie nesie `title` nižšie,
    // ktorý sa nemení.
    text: `Σ ${String(vt.remaining)}`,
    title: `Spolu vo všetkých objednávkach: ${String(vt.total)} ks · nevybavené: ${String(vt.remaining)} ks`,
  };
}

// issue 65 — priamy náprotivok starej appky's `orderAgeDays`/`STALE_ORDER_DAYS`
// (`app.js:169-176`, `>14` → badge). `placedAt` tu nesie plný timestamp
// (issue 59), na rozdiel od starej appky's dátum-bez-času `orderDate` —
// počítanie priamo od neho (nie od polnoci dňa objednávky) je presnejšie a
// nestráca informáciu orezaním na dátum.
export const STALE_ORDER_LINE_DAYS = 14;

export function orderLineAgeDays(placedAt: string, now: Date = new Date()): number {
  const placedMs = new Date(placedAt).getTime();
  return Math.max(0, Math.floor((now.getTime() - placedMs) / 86_400_000));
}

// Badge sa zobrazí LEN pre NEVYBAVENÝ riadok (`isLineResolved` vyššie — tá
// istá kanonická definícia ako všade inde, nikdy nová) starší než
// `STALE_ORDER_LINE_DAYS`. Hranica: presne 14 dní → BEZ badge (`14 > 14` je
// `false`), 15 dní → S badge — rovnaké správanie ako stará appka.
export function isStaleOrderLine(
  line: Pick<OrderLine, "ordered" | "state" | "placedAt">,
  now: Date = new Date(),
): boolean {
  return !isLineResolved(line) && orderLineAgeDays(line.placedAt, now) > STALE_ORDER_LINE_DAYS;
}

// issue 105 bod 2's `shouldShowSizeLabel` (KÓD+VEĽKOSŤ zlúčenie, issue 95)
// bola odstránená spolu so svojimi 3 testami — issue 117 zrušilo celý KÓD
// stĺpec (jej jediné volanie miesto v `OrderLineRow.tsx`), takže funkcia
// ostala nepoužitá mŕtva produkčná logika (code review PR #124, MVP
// philosophy: "remove unused code aggressively").

// issue 237: "Súhrn o objednávaní" na obrazovke "Na objednanie" — počet
// DOTKNUTÝCH objednávok (nie riadkov) a dátum najstaršej čakajúcej
// objednávky. Obe funkcie počítajú NAD CELOU (nefiltrovanou) množinou
// riadkov naprieč VŠETKÝMI dodávateľmi — volajúci (`OrdersOverviewTiles.tsx`)
// posiela vždy VŠETKY riadky zo `suppliers`, nikdy pohľad zúžený prepínačom
// "skryť vybavené" alebo vybraným dodávateľom (rovnaký zámer ako
// `computeVariantTotals` vyššie). Obe používajú TEN ISTÝ kanonický predikát
// `isLineResolved` — žiadna nová/duplicitná definícia "vybavené".

/**
 * Počet ROZLIŠNÝCH objednávok (`orderId`), ktoré majú aspoň jeden NEVYBAVENÝ
 * riadok. Priamy náprotivok `summarizeOrderLines(...).remaining` (počet
 * RIADKOV), len na úrovni OBJEDNÁVKY — jedna objednávka môže mať viacero
 * nevybavených riadkov (rôzne varianty/dodávatelia), počíta sa len raz.
 */
export function countAffectedOrders(
  lines: readonly Pick<OrderLine, "ordered" | "state" | "orderId">[],
): number {
  const orderIds = new Set<string>();
  for (const line of lines) {
    if (!isLineResolved(line)) orderIds.add(line.orderId);
  }
  return orderIds.size;
}

/**
 * `placedAt` (ISO 8601 reťazec) najstaršieho NEVYBAVENÉHO riadku, alebo
 * `null`, keď nie je žiadny nevybavený riadok. `placedAt` je vždy ISO 8601
 * (`queries.ts`'s `.toISOString()`), takže reťazcové porovnanie zodpovedá
 * chronologickému poradiu bez parsovania (rovnaký zámer ako `queries.ts`'s
 * zoskupovacie triedenie).
 */
export function oldestWaitingPlacedAt(
  lines: readonly Pick<OrderLine, "ordered" | "state" | "placedAt">[],
): string | null {
  let oldest: string | null = null;
  for (const line of lines) {
    if (isLineResolved(line)) continue;
    if (oldest === null || line.placedAt < oldest) oldest = line.placedAt;
  }
  return oldest;
}

// issue 237 (code review, minor): slovenčina má pri počítateľných
// podstatných menách TRI tvary (1 → jednotné číslo, 2-4 → málopočetné
// (paucal), 0/5+ vrátane 22/23/24… → rodový pád množného čísla — na rozdiel
// od ruštiny/poľštiny sa tvar NEODVODZUJE z poslednej číslice). Priamy
// náprotivok `apps/api/src/modules/orders/ingest.ts`'s (neexportovanej)
// `formatCount` — rovnaká sadzba, len na frontende, kde appka počet
// objednávok skloňuje priamo v texte dlaždice ("Prehľad e-shopu"), nie len
// spolu s neutrálnou jednotkou ako `formatVariantTotalChip`'s "N ks".
export function formatOrderCount(n: number): string {
  if (n === 1) return "1 objednávka";
  if (n === 2 || n === 3 || n === 4) return `${String(n)} objednávky`;
  return `${String(n)} objednávok`;
}
