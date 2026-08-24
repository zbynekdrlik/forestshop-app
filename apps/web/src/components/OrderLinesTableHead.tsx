import type { JSX } from "react";

// issue 484: `<colgroup>` (9 stĺpcov) + `<thead>` tabuľky riadkov objednávok,
// vyčlenené zo `SupplierOrderGroup.tsx` (BEZ zmeny markupu), aby ho mohla
// znovupoužiť aj sekcia „Riešiť" v rozrolovanom detaile objednávky. Predtým
// jediná kópia — teraz JEDEN zdroj pravdy pre 9-stĺpcovú schému (dovtedy ju
// držal len komentár + `ORDERS_TABLE_COLUMN_COUNT` v `OrderLineRow.tsx`).
// Statický, bez props — DOM je bajt-identický s pôvodným, takže existujúce
// testy „Na objednanie" ostávajú v platnosti.
export function OrderLinesTableHead(): JSX.Element {
  return (
    <>
      {/* issue 95/117: 9 stĺpcov s percentuálnymi šírkami (`app.css`'s `.col-*`),
          `table-layout: fixed` na `.orders-table`. Popisky sú skrátené (plný
          význam v `title`), viď `.claude/rules/frontend-design.md` (issue 105). */}
      <colgroup>
        <col className="col-ordered" />
        <col className="col-order" />
        <col className="col-customer" />
        <col className="col-product" />
        <col className="col-qty" />
        <col className="col-supplier" />
        <col className="col-state" />
        <col className="col-date" />
        <col className="col-notes" />
      </colgroup>
      <thead>
        <tr>
          <th title="Objednané u dodávateľa (zaškrtávacie políčko)" aria-label="Objednané u dodávateľa">
            ✓
          </th>
          <th title="Číslo objednávky (klik na kód v riadku otvorí objednávku v administrácii Shoptet)">
            Č. obj.
          </th>
          <th>Zákazník</th>
          <th>Produkt</th>
          <th title="Množstvo (počet kusov)">Ks</th>
          <th title="Dodávateľ z katalógu, alebo ručné priradenie pri produkte bez katalógového dodávateľa">
            Dodávateľ
          </th>
          <th>Stav</th>
          <th title="Dátum objednávky">Dátum obj.</th>
          <th title="Poznámka zákazníka z e-shopu (na čítanie) + vlastná poznámka tímu">Poznámky</th>
        </tr>
      </thead>
    </>
  );
}
