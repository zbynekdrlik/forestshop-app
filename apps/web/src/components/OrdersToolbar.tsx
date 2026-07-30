import type { JSX } from "react";
import type { OrderLine, SupplierOpenOrders } from "../ordersApi.js";
import { formatOrderSummaryText, summarizeOrderLines } from "../ordersSummary.js";

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
  const allSummary = summarizeOrderLines(allLines);
  const allDone = allLines.length > 0 && allSummary.remaining === 0;

  return (
    <div className="orders-toolbar" data-testid="orders-toolbar">
      <div className="chip-row">
        <button
          type="button"
          className={"chip" + (selectedSupplier === null ? " active" : "") + (allDone ? " done" : "")}
          data-testid="supplier-chip-all"
          onClick={() => {
            onSelectSupplier(null);
          }}
        >
          {`Všetci (${String(allLines.length)})`}
        </button>
        {suppliers.map((group) => {
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
