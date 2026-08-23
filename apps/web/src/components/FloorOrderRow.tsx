import type { JSX } from "react";
import { formatSkDate } from "../formatDate.js";
import type { FloorOrderRow as FloorOrderRowData } from "../ordersApi.js";

// issue 480: JEDEN predajňový riadok v tabuľke „Na objednanie" — produkt
// pripnutý na nevybavenom zápise „Objednávky predajňa", zaradený pod svojho
// dodávateľa. Vykresľuje sa v TEJ ISTEJ tabuľke ako `OrderLineRow` (rovnakých
// 9 stĺpcov `<colgroup>` v `SupplierOrderGroup.tsx`), aby vizuálne zapadol —
// ale NEMÁ stavové tlačidlá ani odkaz do Shoptet administrácie (zadanie): na
// mieste čísla objednávky je znak 🛍️ + odkaz na zápis (`?tab=floor-orders`),
// a jediná ovládateľná vec je checkbox „objednané". Kľúčované dvojicou
// (noteId, variantCode) — `floor_note_product` unikátny kľúč, a jeden produkt
// môže byť pripnutý na viacerých zápisoch.
//
// Testid ZÁMERNE nezačína „order-line-" — viacero e2e testov hľadá hlavný
// riadok cez `[data-testid^='order-line-']` (`.claude/rules/frontend-design.md`,
// issue 162); zhodný prefix by spôsobil Playwright strict-mode kolíziu.
export function FloorOrderRow({
  row,
  canChangeState,
  busyFloorRowKey,
  supplierBusy,
  onChangeOrdered,
}: {
  readonly row: FloorOrderRowData;
  readonly canChangeState: boolean;
  // Kľúč (`noteId::variantCode`) floor riadku, ktorého zápis „objednané" PRÁVE
  // TERAZ prebieha — `null` keď žiadny.
  readonly busyFloorRowKey: string | null;
  // TRUE, keď beží hromadné „označiť/zrušiť skupinu" pre dodávateľa tohto
  // riadku (zrkadlí `OrderLineRow`'s `supplierBusy`, issue 60 — obojsmerný
  // busy-guard).
  readonly supplierBusy: boolean;
  readonly onChangeOrdered: (noteId: string, variantCode: string, ordered: boolean) => void;
}): JSX.Element {
  const rowKey = `${row.noteId}::${row.variantCode}`;
  const busyHere = busyFloorRowKey === rowKey;

  return (
    <tr
      className={"order-row floor-order-row" + (row.ordered ? " ordered" : "")}
      data-testid={`floor-order-row-${row.noteId}-${row.variantCode}`}
    >
      <td>
        <input
          type="checkbox"
          data-testid={`floor-ordered-checkbox-${row.noteId}-${row.variantCode}`}
          aria-label={`Označiť predajňový riadok ${row.variantCode} (zápis predajne) ako objednané u dodávateľa`}
          checked={row.ordered}
          disabled={!canChangeState || busyHere || supplierBusy}
          onChange={(e) => {
            onChangeOrdered(row.noteId, row.variantCode, e.target.checked);
          }}
        />
      </td>
      {/* Na mieste čísla objednávky: 🛍️ + odkaz na zápis v „Objednávky
          predajňa" (`?tab=floor-orders`). Rovnaký tab v tom istom okne (na
          rozdiel od order riadku, ktorý otvára Shoptet v novom okne) — obsluha
          ide zápis rovno upraviť/vybaviť. */}
      <td className="ord-order-cell">
        <a
          href="?tab=floor-orders"
          className="floor-order-link"
          data-testid={`floor-order-link-${row.noteId}-${row.variantCode}`}
          aria-label="Otvoriť zápis v Objednávky predajňa"
          title="Objednávka predajňa — otvoriť zápis"
        >
          <span aria-hidden="true">🛍️</span>
        </a>
      </td>
      {/* Meno zákazníka = prvý riadok textu zápisu (server ho už orezal). */}
      <td>{row.customerName}</td>
      {/* Produkt: názov + veľkosť (ako order riadok) + kód produktu (zadanie
          klienta „Kód produktu") ako tlmený druhý riadok. */}
      <td>
        <div className="ord-product-name">
          {row.productName}
          {row.sizeLabel !== null && <span className="ord-size">{row.sizeLabel}</span>}
        </div>
        <div className="floor-order-code" data-testid={`floor-code-${row.noteId}-${row.variantCode}`}>
          {row.variantCode}
        </div>
      </td>
      <td className="ord-qty">
        <div className="ord-qty-stack">
          <span>{row.quantity} ks</span>
        </div>
      </td>
      {/* Dodávateľ: prázdne — floor riadok je už v skupine svojho dodávateľa. */}
      <td />
      {/* Stav: ŽIADNE stavové tlačidlá (zadanie) — predajňový riadok má len
          „objednané". */}
      <td />
      <td className="ord-date-cell">{formatSkDate(row.createdAt)}</td>
      {/* Poznámky: prázdne — text zápisu je v „Objednávky predajňa". */}
      <td />
    </tr>
  );
}
