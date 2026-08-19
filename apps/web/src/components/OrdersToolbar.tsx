import type { JSX } from "react";
import type { OrderLine, SupplierOpenOrders } from "../ordersApi.js";
import { formatOrderSummaryText, sortSuppliersForChips, summarizeOrderLines } from "../ordersSummary.js";

// issue 61 — filtrovacie štítky dodávateľov + súhrn "ostáva vybaviť" +
// prepínač "skryť vybavené". Čisto prezentačný komponent: `OrdersSection.tsx`
// zostáva vlastníkom dát aj stavu (vybraný dodávateľ, prepínač), presne ako
// pri `OrderLineRow`/`SupplierActionsPanel` — sem sa posielajú len hodnoty +
// callbacky.
export function OrdersToolbar({
  suppliers,
  selectedSupplier,
  onSelectSupplier,
  hideResolved,
  onToggleHideResolved,
}: {
  readonly suppliers: readonly SupplierOpenOrders[];
  readonly selectedSupplier: string | null;
  readonly onSelectSupplier: (supplier: string | null) => void;
  readonly hideResolved: boolean;
  readonly onToggleHideResolved: () => void;
}): JSX.Element {
  const allLines: readonly OrderLine[] = suppliers.flatMap((group) => group.lines);
  const scopedLines =
    selectedSupplier === null ? allLines : (suppliers.find((g) => g.supplier === selectedSupplier)?.lines ?? []);

  return (
    <div className="orders-toolbar" data-testid="orders-toolbar">
      <div className="chip-row">
        {/* issue 263: majiteľ, "'Všetci' chip keeps its neutral/selected
            behaviour — it has no data state of its own" — na rozdiel od
            skutočného dodávateľa (súčet naprieč VŠETKÝMI dodávateľmi zriedka
            znamená niečo akčné) nikdy nedostáva `done` (červená/zelená),
            `.chip-all` (`app.css`) ho drží neutrálny, kým sa nevyberie. */}
        <button
          type="button"
          className={"chip chip-all" + (selectedSupplier === null ? " active" : "")}
          data-testid="supplier-chip-all"
          onClick={() => {
            onSelectSupplier(null);
          }}
        >
          {`Všetci (${String(allLines.length)})`}
        </button>
        {/* issue 452: čipy dodávateľov zoradené abecedne (slovenské locale,
            case-insensitive), "(bez dodávateľa)" naposledy — čip "Všetci" vyššie
            ostáva vždy prvý. Farby/počty/správanie sa nemenia, len poradie;
            `allLines`/`scopedLines` (súčty) ostávajú nad pôvodným `suppliers`. */}
        {sortSuppliersForChips(suppliers).map((group) => {
          const groupSummary = summarizeOrderLines(group.lines);
          const done = group.lines.length > 0 && groupSummary.remaining === 0;
          return (
            <button
              key={group.supplier}
              type="button"
              className={"chip" + (selectedSupplier === group.supplier ? " active" : "") + (done ? " done" : "")}
              data-testid={`supplier-chip-${group.supplier}`}
              onClick={() => {
                onSelectSupplier(group.supplier);
              }}
            >
              {`${group.supplier} (${String(group.lines.length)})`}
            </button>
          );
        })}
      </div>
      <div className="orders-toolbar-summary-row">
        <p className="orders-summary" data-testid="orders-summary">
          {formatOrderSummaryText(summarizeOrderLines(scopedLines), selectedSupplier)}
        </p>
        <button
          type="button"
          className={"btn sm ghost" + (hideResolved ? " on" : "")}
          data-testid="orders-hide-resolved-toggle"
          title={
            hideResolved
              ? "Zobraziť aj riadky, ktoré sú už vybavené"
              : "Skryť riadky, ktoré sú už vybavené (objednané / čaká sa / skladom / nedostupné)"
          }
          onClick={onToggleHideResolved}
        >
          {hideResolved ? "🙈 Vybavené skryté" : "👁 Skryť vybavené"}
        </button>
      </div>
    </div>
  );
}
