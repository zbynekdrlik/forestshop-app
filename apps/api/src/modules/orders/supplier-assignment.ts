import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, productSupplierOverrides, products, variants } from "../../db/schema.js";
import { record } from "../audit/service.js";

export type AssignOrderLineSupplierResult = "ok" | "not_found" | "already_has_supplier";

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
// issue 86 (nezávislý audit): server si dovtedy NIKDY neoverila, že produkt
// naozaj nemá dodávateľa v katalógu — pravidlo "priradiť sa smie len riadok
// bez `product.supplier`" (`queries.ts`'s `supplierAssignable`) bolo
// vynucované LEN vo frontende (`OrderLineRow.tsx`). Zabudnutá otvorená
// stránka, priame API volanie, alebo súbeh s nočným importom katalógu medzi
// načítaním a odoslaním mohli zapísať override aj pre produkt, ktorý UŽ
// dodávateľa má — override by potom ležal nečinne (`effectiveSupplierSql`
// uprednostní katalóg), kým neskorší import katalógu legitímne nevráti
// `product.supplier` späť na `null`, čím by sa starý pravopis potichu znova
// aktivoval bez zásahu manažéra. Fix: SELECT teraz číta aj `products.supplier`
// (JOIN na `products`, dovtedy chýbajúci — pôvodný SELECT sa cez `variants`
// k nemu vôbec nedostal) a podmienka sa vyhodnotí VNÚTRI TEJ ISTEJ transakcie
// ako upsert nižšie. Žiadne `.for("update")` naviac — rovnaké zdôvodnenie ako
// komentár nižšie (fallback pole pre nízkofrekventovanú ručnú akciu, nie dáta
// citlivé na mikrosekundové okno súbehu).
export async function assignOrderLineSupplier(
  db: Database,
  input: AssignOrderLineSupplierInput,
): Promise<AssignOrderLineSupplierResult> {
  return db.transaction(async (tx) => {
    const [line] = await tx
      .select({ productKey: variants.productKey, catalogSupplier: products.supplier })
      .from(orderLines)
      .innerJoin(variants, eq(variants.code, orderLines.variantCode))
      .innerJoin(products, eq(products.key, variants.productKey))
      .where(eq(orderLines.id, input.lineId))
      .limit(1);
    if (line === undefined) return "not_found";
    if (line.catalogSupplier !== null) return "already_has_supplier";

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
