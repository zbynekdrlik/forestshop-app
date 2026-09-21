import type { JSX } from "react";

// issue 500: vyčlenené z `OrderLineRow.tsx` (prekročil eslint `max-lines: 400`
// po pridaní @ tlačidla) — čisto PREZENTAČNÝ obsah bunky DODÁVATEĽ: veľké
// ikonové tlačidlo odkazu (🔗) / poznámka dodávateľa / popis „Priradiť
// dodávateľa" / pomlčka. Rovnaké DOM aj logika ako predtým (žiadna zmena
// existujúcich testov — `.ord-supplier-cell` textContent ostáva presne „—"
// pre riadok bez údajov, `OrdersSection.test.tsx`/`supplierAssignCell.test`).
//
// issue 575: berie ÚZKY `data` objekt (predtým celý `line: OrderLine`), aby ho
// vedel použiť AJ predajňový riadok (`FloorOrderRow` — ten `supplierAssignable`
// nemá, posiela `false`, a `productName` namiesto `variantName`). `OrderLine`
// štrukturálne spĺňa `SupplierLinkDisplayData`, takže order-line call-site
// odovzdá rovno `data={line}` (jeden riadok, žiadny nárast `max-lines`).
export interface SupplierLinkDisplayData {
  readonly supplierUrl: string | null;
  readonly supplierNote: string | null;
  readonly supplierAssignable: boolean;
  readonly variantName: string;
  readonly variantCode: string;
}

export function OrderSupplierLinkDisplay({ data }: { readonly data: SupplierLinkDisplayData }): JSX.Element {
  if (data.supplierUrl !== null) {
    // issue 119: textový odkaz nahradený veľkým ikonovým tlačidlom (36×36px
    // klikacia plocha). `aria-label`/`title` nesú popis (issue 72: variantName
    // sám nestačí — dva riadky rovnakého produktu v rôznych veľkostiach majú
    // zhodný názov, líšia sa len `variantCode`); viditeľný text je len ikonka.
    return (
      <a
        href={data.supplierUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="ord-supplier-link"
        aria-label={`Odkaz na dodávateľa — ${data.variantName} (${data.variantCode})`}
        title={`Otvoriť odkaz na dodávateľa — ${data.variantName} (${data.variantCode})`}
      >
        <span aria-hidden="true">🔗</span>
      </a>
    );
  }
  if (data.supplierNote !== null) {
    return (
      <span className="ord-supplier-note" title={data.supplierNote}>
        {data.supplierNote}
      </span>
    );
  }
  if (data.supplierAssignable) {
    // issue 107 bod 3: viditeľný popis toho, čo vstup pod bunkou robí (namiesto
    // holej pomlčky) — zámerne v TEJTO existujúcej bunke, aby nepribudol riadok
    // výšky (issue 105 invariant).
    return <span className="ord-supplier-assign-hint">Priradiť dodávateľa</span>;
  }
  // issue 117: `externalCode` (dodávateľský kód) sa už NIKDY nezobrazuje —
  // terminálny stav bez odkazu/poznámky/priradenia je VŽDY pomlčka.
  return <>—</>;
}
