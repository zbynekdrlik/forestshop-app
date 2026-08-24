import type { JSX } from "react";
import type { FloorOrderRow, OrderLine, SupplierOpenOrders } from "../ordersApi.js";
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
  // issue 480: predajňové riadky vstupujú do počtov čipov aj do súhrnu rovnako
  // ako riadky objednávok (inak by čip/„Všetci"/súhrn driftovali od nástenkového
  // odznaku a od hlavičky skupiny — issue 263 invariant „čip == panel").
  const allFloorRows: readonly FloorOrderRow[] = suppliers.flatMap((group) => group.floorRows ?? []);
  const scopedGroup = selectedSupplier === null ? null : suppliers.find((g) => g.supplier === selectedSupplier);
  const scopedLines = selectedSupplier === null ? allLines : (scopedGroup?.lines ?? []);
  const scopedFloorRows = selectedSupplier === null ? allFloorRows : (scopedGroup?.floorRows ?? []);

  // Súhrn „ostáva vybaviť N z M" — predajňové riadky pridávajú svoje KUSY do
  // total/remaining (neobjednaný = remaining, ako order riadok). Rozpis
  // (Objednané/Čaká sa/…) ostáva iba pre order riadky (predajňový riadok nemá
  // stav), takže sa doň nemieša.
  const baseSummary = summarizeOrderLines(scopedLines);
  const floorTotalQty = scopedFloorRows.reduce((sum, row) => sum + row.quantity, 0);
  const floorRemainingQty = scopedFloorRows.filter((row) => !row.ordered).reduce((sum, row) => sum + row.quantity, 0);
  const summary = { ...baseSummary, total: baseSummary.total + floorTotalQty, remaining: baseSummary.remaining + floorRemainingQty };

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
          {`Všetci (${String(allLines.length + allFloorRows.length)})`}
        </button>
        {/* issue 452: čipy dodávateľov zoradené abecedne (slovenské locale,
            case-insensitive), "(bez dodávateľa)" naposledy — čip "Všetci" vyššie
            ostáva vždy prvý. Farby/počty/správanie sa nemenia, len poradie;
            `allLines`/`scopedLines` (súčty) ostávajú nad pôvodným `suppliers`. */}
        {sortSuppliersForChips(suppliers).map((group) => {
          const groupFloorRows = group.floorRows ?? [];
          // issue 480: `done` (a počet) zhodné s hlavičkou skupiny
          // (`SupplierActionsPanel`) — vybavené je VŠETKO: objednávky aj
          // predajňové riadky. `[].every() === true`, takže skupina bez
          // predajňových riadkov sa správa presne ako doteraz.
          const done =
            group.lines.length + groupFloorRows.length > 0 &&
            summarizeOrderLines(group.lines).remaining === 0 &&
            groupFloorRows.every((row) => row.ordered);
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
              {`${group.supplier} (${String(group.lines.length + groupFloorRows.length)})`}
            </button>
          );
        })}
      </div>
      <div className="orders-toolbar-summary-row">
        <p className="orders-summary" data-testid="orders-summary">
          {formatOrderSummaryText(summary, selectedSupplier)}
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
