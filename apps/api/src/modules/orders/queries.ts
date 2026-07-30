import { asc, desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, orders, products, supplierContacts, variants, type OrderLineState } from "../../db/schema.js";
import { extractSupplierLink } from "../catalog/supplier-link.js";

export interface OpenOrderLine {
  readonly lineId: string;
  readonly orderId: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  readonly comment: string | null;
  readonly placedAt: string;
  readonly variantCode: string;
  readonly variantName: string;
  readonly sizeLabel: string | null;
  readonly quantity: number;
  readonly state: OrderLineState;
  // issue 67: odkaz na tovar u dodávateľa (extrahovaný z `product.internalNote`
  // cez `extractSupplierLink`) a kód tovaru u dodávateľa (`variant.externalCode`,
  // priamo). `supplierUrl` je `null`, keď v `internalNote` nie je odkaz —
  // vtedy `supplierNote` (surový pôvodný text, ak nejaký je) slúži ako
  // plain-text fallback na obrazovke.
  readonly supplierUrl: string | null;
  readonly supplierNote: string | null;
  readonly externalCode: string | null;
}

export interface SupplierOpenOrders {
  readonly supplier: string;
  readonly lines: readonly OpenOrderLine[];
  // E-mailový kontakt dodávateľa (#31), `null` keď zatiaľ nenastavený —
  // `supplier_contact` je samostatná tabuľka (manažér ju edituje nezávisle
  // od importu objednávok), preto sa dopytuje osobitne od hlavného
  // zoskupovacieho dopytu nižšie, nie cez JOIN naň (zástupný kľúč
  // "(bez dodávateľa)" nemá zodpovedajúci `product.supplier`, na ktorý by sa
  // dalo joinovať — kontakt sa priraďuje AŽ PO zoskupení, podľa rovnakého
  // zobrazovaného kľúča).
  readonly email: string | null;
}

// `product.supplier` je v schéme nepovinné (`text("supplier")`, bez
// `.notNull()`) — Shoptet export niekedy nesie prázdnu hodnotu (`map-row.ts`'s
// `textOrNull`). Zoskupenie takých riadkov dostáva čitateľný zástupný kľúč
// namiesto toho, aby zmizli/spadli na `null` kľúč v Mape.
// Exportované (nie len modulová konštanta) — `modules/orders/mail.ts` (#31)
// potrebuje TEN ISTÝ reťazec pri hľadaní kontaktu/agregovaní outstanding
// riadkov pre zástupnú skupinu, nikdy vlastnú duplicitnú definíciu, ktorá by
// sa mohla rozísť.
export const NEZNAMY_DODAVATEL = "(bez dodávateľa)";

// Zoskupenie je na ÚROVNI RIADKA objednávky, nie na úrovni objednávky —
// jedna objednávka môže obsahovať položky od VIACERÝCH dodávateľov
// (`docs/stara-appka-inventar.md` bod 1: "Otvorené objednávky zoskupené
// podľa dodávateľa"). "Otvorená" v v1 znamená VŠETKY riadky objednávok —
// `order_line.state` (objednane/caka_sa/skladom/nedostupne) zatiaľ nemá
// žiadny "hotový/zatvorený" stav (ten príde až s #25), takže nič dnes riadok
// z tohto zoznamu neodstráni.
export async function listOpenOrderLinesBySupplier(db: Database): Promise<readonly SupplierOpenOrders[]> {
  const rows = await db
    .select({
      lineId: orderLines.id,
      orderId: orders.id,
      externalOrderId: orders.externalOrderId,
      customerName: orders.customerName,
      comment: orders.comment,
      placedAt: orders.placedAt,
      variantCode: orderLines.variantCode,
      variantName: variants.name,
      sizeLabel: variants.sizeLabel,
      quantity: orderLines.quantity,
      state: orderLines.state,
      supplier: products.supplier,
      internalNote: products.internalNote,
      externalCode: variants.externalCode,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(variants, eq(variants.code, orderLines.variantCode))
    .innerJoin(products, eq(products.key, variants.productKey))
    // Sekundárne triedenie podľa najnovšej objednávky ako prvej v rámci
    // dodávateľa — rovnaký zámer ako katalógov `desc(fetchedAt), desc(id)`
    // tie-break, len tu na `placedAt`/`lineId`, aby poradie bolo stabilné aj
    // pri zhodnom čase.
    .orderBy(asc(products.supplier), desc(orders.placedAt), desc(orderLines.id));

  const bySupplier = new Map<string, OpenOrderLine[]>();
  for (const row of rows) {
    const supplierLink = extractSupplierLink(row.internalNote);
    const line: OpenOrderLine = {
      lineId: row.lineId,
      orderId: row.orderId,
      externalOrderId: row.externalOrderId,
      customerName: row.customerName,
      comment: row.comment,
      placedAt: row.placedAt.toISOString(),
      variantCode: row.variantCode,
      variantName: row.variantName,
      sizeLabel: row.sizeLabel,
      quantity: row.quantity,
      state: row.state,
      supplierUrl: supplierLink.url,
      supplierNote: supplierLink.note,
      externalCode: row.externalCode,
    };
    const supplierKey = row.supplier ?? NEZNAMY_DODAVATEL;
    let lines = bySupplier.get(supplierKey);
    if (lines === undefined) {
      lines = [];
      bySupplier.set(supplierKey, lines);
    }
    lines.push(line);
  }

  const contactRows = await db
    .select({ supplier: supplierContacts.supplier, email: supplierContacts.email })
    .from(supplierContacts);
  const emailBySupplier = new Map(contactRows.map((row) => [row.supplier, row.email]));

  // `Map` uchováva poradie prvého vloženia kľúča — keďže hlavný dopyt už
  // triedi `asc(products.supplier)`, výsledné poradie skupín je abecedné bez
  // ďalšieho triedenia tu.
  return [...bySupplier.entries()].map(([supplier, lines]) => ({
    supplier,
    lines,
    email: emailBySupplier.get(supplier) ?? null,
  }));
}

export interface OrderDetailLine {
  readonly lineId: string;
  readonly variantCode: string;
  readonly variantName: string;
  readonly sizeLabel: string | null;
  readonly supplier: string;
  readonly quantity: number;
  readonly state: OrderLineState;
}

export interface OrderDetail {
  readonly id: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  readonly comment: string | null;
  readonly placedAt: string;
  readonly lines: readonly OrderDetailLine[];
}

export async function getOrderDetail(db: Database, id: string): Promise<OrderDetail | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (order === undefined) return null;

  const lineRows = await db
    .select({
      lineId: orderLines.id,
      variantCode: orderLines.variantCode,
      variantName: variants.name,
      sizeLabel: variants.sizeLabel,
      supplier: products.supplier,
      quantity: orderLines.quantity,
      state: orderLines.state,
    })
    .from(orderLines)
    .innerJoin(variants, eq(variants.code, orderLines.variantCode))
    .innerJoin(products, eq(products.key, variants.productKey))
    .where(eq(orderLines.orderId, id))
    .orderBy(asc(products.supplier), asc(variants.code));

  return {
    id: order.id,
    externalOrderId: order.externalOrderId,
    customerName: order.customerName,
    comment: order.comment,
    placedAt: order.placedAt.toISOString(),
    lines: lineRows.map((row) => ({ ...row, supplier: row.supplier ?? NEZNAMY_DODAVATEL })),
  };
}
