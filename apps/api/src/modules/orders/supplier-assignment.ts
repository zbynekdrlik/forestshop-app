import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, productSupplierOverrides, variants } from "../../db/schema.js";
import { record } from "../audit/service.js";

export type AssignOrderLineSupplierResult = "ok" | "not_found";

export interface AssignOrderLineSupplierInput {
  readonly lineId: string;
  // Už orezané + neprázdne — validované `zValidator` na HTTP hranici
  // (`z.string().trim().min(1)`, `orders-routes.ts`). Case sa NEFOLDUJE,
  // whitespace sa NEZBIERA opakovane tu (schéma to už spravila) — presne
  // to, čo manažér napísal, sa uloží.
  readonly supplier: string;
  readonly actorUserId: string;
  readonly now: Date;
}

// issue 63: ručné priradenie dodávateľa produktu (nie riadku!) —
// `product_supplier_override` je kľúčovaná `productKey`, takže priradenie
// cez JEDEN riadok objednávky automaticky platí aj pre KAŽDÝ ĎALŠÍ riadok
// toho istého produktu (iná veľkosť, iná objednávka) bez ďalšieho zápisu —
// čítacia strana (`queries.ts`'s `effectiveSupplierSql`) ho vyrieši cez JOIN.
// Rovnaký vzor ako `supplier-contact.ts`'s `setSupplierContactEmail`
// (jednoduchý upsert + audit v JEDNEJ transakcii, žiadne `.for("update")`
// naviac) — na rozdiel od `state.ts`'s `setOrderLineState`/`setOrderLineOrdered`
// tu neexistuje zmysluplný "z akého stavu do akého" pre AUDIT (nová hodnota
// jednoducho prepíše starú, rovnako ako pri e-mailovom kontakte), takže
// prísnejšie zamykanie proti súbežnému prepisu tej istej hodnoty by pridalo
// zložitosť bez reálneho prínosu — Postgres `onConflictDoUpdate` je aj tak
// atomický, posledný zápis vyhráva presne tak, ako pri kontakte.
export async function assignOrderLineSupplier(
  db: Database,
  input: AssignOrderLineSupplierInput,
): Promise<AssignOrderLineSupplierResult> {
  return db.transaction(async (tx) => {
    const [line] = await tx
      .select({ productKey: variants.productKey })
      .from(orderLines)
      .innerJoin(variants, eq(variants.code, orderLines.variantCode))
      .where(eq(orderLines.id, input.lineId))
      .limit(1);
    if (line === undefined) return "not_found";

    await tx
      .insert(productSupplierOverrides)
      .values({ productKey: line.productKey, supplier: input.supplier, updatedAt: input.now })
      .onConflictDoUpdate({
        target: productSupplierOverrides.productKey,
        set: { supplier: input.supplier, updatedAt: input.now },
      });

    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "product_supplier_override.changed",
      entity: "product_supplier_override",
      entityId: line.productKey,
      data: { productKey: line.productKey, lineId: input.lineId, supplier: input.supplier },
    });

    return "ok";
  });
}
