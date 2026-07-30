import type { OrderLine } from "./ordersApi.js";

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

export interface OrderLinesSummary {
  readonly total: number;
  readonly remaining: number;
  readonly ordered: number;
  readonly waiting: number;
  readonly stock: number;
  readonly unavailable: number;
}

/**
 * Rozpis NIE JE rozklad `total` na disjunktné časti — jeden riadok môže byť
 * súčasne `ordered` AJ v inom stave než "objednane" (rovnaký zámer ako stará
 * appka's `toOrderSummary`, ktorej komentár to hovorí výslovne: "the
 * breakdown is not a partition of total"). `remaining` sa preto počíta
 * priamo cez `isLineResolved`, nikdy odčítaním súčtu rozpisu od `total`.
 */
export function summarizeOrderLines(
  lines: readonly Pick<OrderLine, "ordered" | "state">[],
): OrderLinesSummary {
  let ordered = 0;
  let waiting = 0;
  let stock = 0;
  let unavailable = 0;
  let remaining = 0;
  for (const line of lines) {
    if (line.ordered) ordered += 1;
    if (line.state === "caka_sa") waiting += 1;
    if (line.state === "skladom") stock += 1;
    if (line.state === "nedostupne") unavailable += 1;
    if (!isLineResolved(line)) remaining += 1;
  }
  return { total: lines.length, remaining, ordered, waiting, stock, unavailable };
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
    text: `Σ spolu ${String(vt.remaining)} ks`,
    title: `Spolu vo všetkých objednávkach: ${String(vt.total)} ks · nevybavené: ${String(vt.remaining)} ks`,
  };
}
