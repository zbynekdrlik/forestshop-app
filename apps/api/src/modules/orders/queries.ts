import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, orders, products, supplierContacts, variants, type OrderLineState } from "../../db/schema.js";
import { extractSupplierLink } from "../catalog/supplier-link.js";
import { listOpenStatusNames } from "./open-statuses.js";

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
  // issue 60: nezávislý príznak "objednané u dodávateľa" (viď komentár k
  // `orderLines.ordered` v `schema-orders.ts`) — oddelené od `state` vyššie.
  readonly ordered: boolean;
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
// podľa dodávateľa"). `order_line.state` (objednane/caka_sa/skladom/
// nedostupne) je appkou/manažérom riadený automat NEZÁVISLÝ od tohto
// filtra — "otvorená" tu (issue 59) znamená, že SAMOTNÁ OBJEDNÁVKA má v
// Shoptete jeden z nastavených stavov (`order.status_name`,
// `open-statuses.ts`), rovnaký zámer ako stará appka's `to_order`. Bez
// nastaveného stavu (čo `replaceOpenStatusNames` nedovolí) by dopyt nemal
// podľa čoho filtrovať — vtedy sa vráti prázdny zoznam namiesto behu
// `inArray` s prázdnym poľom.
export async function listOpenOrderLinesBySupplier(db: Database): Promise<readonly SupplierOpenOrders[]> {
  const openStatuses = await listOpenStatusNames(db);
  if (openStatuses.length === 0) return [];

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
      ordered: orderLines.ordered,
      supplier: products.supplier,
      internalNote: products.internalNote,
      externalCode: variants.externalCode,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(variants, eq(variants.code, orderLines.variantCode))
    .innerJoin(products, eq(products.key, variants.productKey))
    .where(inArray(orders.statusName, [...openStatuses]))
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
      ordered: row.ordered,
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

// issue 60: ID riadkov, ktoré `listOpenOrderLinesBySupplier` PRÁVE TERAZ
// zobrazuje pre JEDNÉHO dodávateľa — používa `modules/orders/state.ts`'s
// `setSupplierLinesOrdered` (hromadné označenie skupiny), aby hromadná akcia
// vždy dopadla presne na to, čo manažér na obrazovke "Na objednanie" vidí.
// Rovnaký filter (otvorené Shoptet stavy) a rovnaký zástupný kľúč
// (`NEZNAMY_DODAVATEL`) ako hlavný zoskupovací dopyt vyššie — zámerne
// SAMOSTATNÝ, užší dopyt (len ID, žiadne meno/veľkosť/odkaz na dodávateľa),
// nie filtrovanie výstupu `listOpenOrderLinesBySupplier` v pamäti, aby
// hromadná akcia nemusela ťahať VŠETKÝCH dodávateľov len kvôli jednému.
//
// Code review (review of PR 75, issue 60, finding 3): pôvodne bežal tento
// dopyt MIMO transakcie, ktorá potom vykonáva hromadný UPDATE — medzi
// prečítaním a zápisom mohol súbežný re-import objednávok alebo per-riadkové
// prepnutie stavu zmeniť, ktoré riadky sú pre daného dodávateľa "otvorené"
// (úzke TOCTOU okno, bez straty dát — zápis ide vždy na explicitné ID — ale
// hromadná akcia mohla občas zasiahnuť riadok, ktorý medzitým opustil/vstúpil
// do otvorenej skupiny). Volajúci (`state.ts`'s `setSupplierLinesOrdered`)
// teraz volá TENTO dopyt AŽ VNÚTRI vlastnej transakcie a `.for("update")`
// zamyká VŠETKY tabuľky JOINu bez ohľadu obmedzenia (žiadny `of` zoznam) —
// vrátane `order`, takže súbežná zmena stavu objednávky (aj `setOrderLineState`'s
// vlastný `.for("update")` na `order_line`) musí počkať na COMMIT tejto
// transakcie, nie naopak. Parameter je preto zúžený na `Pick<Database,
// "select">` (rovnaký vzor ako `audit/service.ts`'s `AuditExecutor`) — `tx`
// (`PgTransaction`) nemá `Database`'s `$client`, takže by ho `tsc` odmietol
// ako celý `Database` (`.claude/rules/database.md`). Regresný dôkaz:
// `tests/orders-supplier-bulk-lock.integration.test.ts`.
export async function listOpenOrderLineIdsForSupplier(
  db: Pick<Database, "select">,
  supplier: string,
): Promise<readonly string[]> {
  const openStatuses = await listOpenStatusNames(db);
  if (openStatuses.length === 0) return [];

  const supplierFilter = supplier === NEZNAMY_DODAVATEL ? isNull(products.supplier) : eq(products.supplier, supplier);

  const rows = await db
    .select({ lineId: orderLines.id })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(variants, eq(variants.code, orderLines.variantCode))
    .innerJoin(products, eq(products.key, variants.productKey))
    .where(and(inArray(orders.statusName, [...openStatuses]), supplierFilter))
    .for("update");

  return rows.map((row) => row.lineId);
}

export interface OrderDetailLine {
  readonly lineId: string;
  readonly variantCode: string;
  readonly variantName: string;
  readonly sizeLabel: string | null;
  readonly supplier: string;
  readonly quantity: number;
  readonly state: OrderLineState;
  // issue 60: rovnaký nezávislý príznak ako `OpenOrderLine.ordered`.
  readonly ordered: boolean;
  // issue 70: tretia čítacia cesta zjednotená s `listOpenOrderLinesBySupplier`
  // a `mail.ts`'s `loadOutstandingLines` — rovnaký zámer, rovnaké polia.
  readonly supplierUrl: string | null;
  readonly supplierNote: string | null;
  readonly externalCode: string | null;
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
      ordered: orderLines.ordered,
      internalNote: products.internalNote,
      externalCode: variants.externalCode,
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
    lines: lineRows.map((row) => {
      const supplierLink = extractSupplierLink(row.internalNote);
      return {
        lineId: row.lineId,
        variantCode: row.variantCode,
        variantName: row.variantName,
        sizeLabel: row.sizeLabel,
        supplier: row.supplier ?? NEZNAMY_DODAVATEL,
        quantity: row.quantity,
        state: row.state,
        ordered: row.ordered,
        supplierUrl: supplierLink.url,
        supplierNote: supplierLink.note,
        externalCode: row.externalCode,
      };
    }),
  };
}
