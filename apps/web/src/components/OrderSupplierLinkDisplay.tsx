import type { JSX } from "react";
import type { OrderLine } from "../ordersApi.js";

// issue 500: vyčlenené z `OrderLineRow.tsx` (prekročil eslint `max-lines: 400`
// po pridaní @ tlačidla) — čisto PREZENTAČNÝ obsah bunky DODÁVATEĽ: veľké
// ikonové tlačidlo odkazu (🔗) / poznámka dodávateľa / popis „Priradiť
// dodávateľa" / pomlčka. Rovnaké DOM aj logika ako predtým (žiadna zmena
// existujúcich testov — `.ord-supplier-cell` textContent ostáva presne „—"
// pre riadok bez údajov, `OrdersSection.test.tsx`/`supplierAssignCell.test`).
export function OrderSupplierLinkDisplay({ line }: { readonly line: OrderLine }): JSX.Element {
  if (line.supplierUrl !== null) {
    // issue 119: textový odkaz nahradený veľkým ikonovým tlačidlom (36×36px
    // klikacia plocha). `aria-label`/`title` nesú popis (issue 72: variantName
    // sám nestačí — dva riadky rovnakého produktu v rôznych veľkostiach majú
    // zhodný názov, líšia sa len `variantCode`); viditeľný text je len ikonka.
    return (
      <a
        href={line.supplierUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="ord-supplier-link"
        aria-label={`Odkaz na dodávateľa — ${line.variantName} (${line.variantCode})`}
        title={`Otvoriť odkaz na dodávateľa — ${line.variantName} (${line.variantCode})`}
      >
        <span aria-hidden="true">🔗</span>
      </a>
    );
  }
  if (line.supplierNote !== null) {
    return (
      <span className="ord-supplier-note" title={line.supplierNote}>
        {line.supplierNote}
      </span>
    );
  }
  if (line.supplierAssignable) {
    // issue 107 bod 3: viditeľný popis toho, čo vstup pod bunkou robí (namiesto
    // holej pomlčky) — zámerne v TEJTO existujúcej bunke, aby nepribudol riadok
    // výšky (issue 105 invariant).
    return <span className="ord-supplier-assign-hint">Priradiť dodávateľa</span>;
  }
  // issue 117: `externalCode` (dodávateľský kód) sa už NIKDY nezobrazuje —
  // terminálny stav bez odkazu/poznámky/priradenia je VŽDY pomlčka.
  return <>—</>;
}
