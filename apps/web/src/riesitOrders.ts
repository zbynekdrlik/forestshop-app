import type { OrderLine, SupplierOpenOrders } from "./ordersApi.js";

// issue 484 (Štěpán, schválené komentárom 5394210094): sekcia „Riešiť" už
// NEskupuje po dodávateľoch — je to plochý zoznam OBJEDNÁVOK (1 objednávka =
// 1 kompaktný riadok s rozrolovaním). Táto čistá funkcia preskupí riadky, ktoré
// `useOrderLinesBoard` už načítal (`board.suppliers[].lines[]`), podľa `orderId`
// — žiadny nový API dopyt, len iná prezentácia toho istého zdroja (tiket:
// „NEduplikuj query logiku — agreguj nad existujúcim zdrojom").
//
// Jedna objednávka jedného zákazníka môže mať riadky u VIACERÝCH dodávateľov
// (Štěpánov príklad: 20261172 = 3 produkty u 3 dodávateľov), preto sa musí
// ploštiť NAPRIEČ všetkými skupinami, nie len v rámci jednej.
export interface RiesitOrder {
  readonly orderId: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  // Poznámka k OBJEDNÁVKE (appkin/manažérov `order.comment`, zdieľaný naprieč
  // riadkami tej istej objednávky) — zobrazuje sa na kompaktnom riadku.
  readonly comment: string | null;
  readonly placedAt: string;
  // Preklik čísla objednávky — rovnaký cieľ (Shoptet admin) ako v „Na
  // objednanie" (`OrderLineRow`'s `line.adminUrl`).
  readonly adminUrl: string;
  // Všetky riadky objednávky v stave riesit (rozrolovanie ukáže tieto).
  readonly lines: readonly OrderLine[];
}

export function groupRiesitLinesByOrder(suppliers: readonly SupplierOpenOrders[]): readonly RiesitOrder[] {
  // `first` = prvý videný riadok objednávky; jej order-level polia
  // (`externalOrderId`/`customerName`/`comment`/`placedAt`/`adminUrl`) sú
  // IDENTICKÉ na každom riadku tej istej objednávky (pochádzajú z `order`
  // riadku), takže stačí zobrať prvý.
  const byOrder = new Map<string, { readonly first: OrderLine; readonly lines: OrderLine[] }>();
  for (const group of suppliers) {
    for (const line of group.lines) {
      const existing = byOrder.get(line.orderId);
      if (existing === undefined) {
        byOrder.set(line.orderId, { first: line, lines: [line] });
      } else {
        existing.lines.push(line);
      }
    }
  }

  const orders = [...byOrder.values()].map(({ first, lines }): RiesitOrder => ({
    orderId: first.orderId,
    externalOrderId: first.externalOrderId,
    customerName: first.customerName,
    comment: first.comment,
    placedAt: first.placedAt,
    adminUrl: first.adminUrl,
    lines,
  }));

  // Najnovšia objednávka prvá (rovnaké poradie ako `queries.ts`'s zoskupovacie
  // triedenie skupín); `placedAt` je ISO 8601, takže reťazcové porovnanie
  // zodpovedá chronologickému poradiu bez parsovania. Pri zhode `placedAt`
  // deterministicky podľa čísla objednávky.
  orders.sort((a, b) => {
    if (a.placedAt !== b.placedAt) return a.placedAt > b.placedAt ? -1 : 1;
    return a.externalOrderId < b.externalOrderId ? -1 : a.externalOrderId > b.externalOrderId ? 1 : 0;
  });
  return orders;
}
