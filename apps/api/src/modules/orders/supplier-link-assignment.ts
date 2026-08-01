import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, productSupplierLinkOverrides, variants } from "../../db/schema.js";
import { record } from "../audit/service.js";

export type SetProductSupplierLinkResult = "ok" | "not_found";

export interface SetProductSupplierLinkInput {
  readonly lineId: string;
  // Už orezané + validované ako URL — `zValidator` na HTTP hranici
  // (`z.string().trim().url()`, `orders-routes.ts`).
  readonly url: string;
  readonly actorUserId: string;
  readonly now: Date;
}

// issue 121: majiteľ, doslovne "pri kazdom produkte ma byt moznost upravit
// link na dodavatela ktory sa potom cez sync na shoptet doplni". Priamy
// náprotivok `assignOrderLineSupplier` (`supplier-assignment.ts`) — rovnaké
// "prijmi lineId, server si sám dopočíta productKey" API (frontend nikdy
// nepotrebuje poznať `productKey` priamo), rovnaký jednoduchý upsert + audit
// v JEDNEJ transakcii bez `.for("update")` naviac (rovnaké zdôvodnenie:
// nízkofrekventovaná ručná akcia, posledný zápis vyhráva, Postgres
// `onConflictDoUpdate` je aj tak atomický).
//
// NA ROZDIEL od `assignOrderLineSupplier` tu ale NIE JE žiadna "už má
// hodnotu" 409 gate — `product_supplier_override` smie manažér priradiť LEN
// keď katalóg pole nemá (`supplierAssignable`), ale odkaz na dodávateľa smie
// upraviť VŽDY, aj keď Shoptet už jeden odkaz uvádza (ticket to žiada
// explicitne: "pri KAŽDOM produkte" — majiteľ opravuje ZLÉ/zastarané odkazy
// rovnako často ako dopĺňa chýbajúce). Preto tu stačí overiť len existenciu
// riadku (`not_found`), nie stav katalógového poľa.
export async function setProductSupplierLink(
  db: Database,
  input: SetProductSupplierLinkInput,
): Promise<SetProductSupplierLinkResult> {
  return db.transaction(async (tx) => {
    const [line] = await tx
      .select({ productKey: variants.productKey })
      .from(orderLines)
      .innerJoin(variants, eq(variants.code, orderLines.variantCode))
      .where(eq(orderLines.id, input.lineId))
      .limit(1);
    if (line === undefined) return "not_found";

    const [previous] = await tx
      .select({ url: productSupplierLinkOverrides.url })
      .from(productSupplierLinkOverrides)
      .where(eq(productSupplierLinkOverrides.productKey, line.productKey))
      .limit(1);

    await tx
      .insert(productSupplierLinkOverrides)
      .values({ productKey: line.productKey, url: input.url, updatedAt: input.now })
      .onConflictDoUpdate({
        target: productSupplierLinkOverrides.productKey,
        set: { url: input.url, updatedAt: input.now },
      });

    // Audit nesie AJ pôvodnú hodnotu (kto/kedy/z čoho/na čo — ticketova
    // akceptačná podmienka), `null` keď doteraz žiadna nebola nastavená.
    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "product_supplier_link_override.changed",
      entity: "product_supplier_link_override",
      entityId: line.productKey,
      data: {
        productKey: line.productKey,
        lineId: input.lineId,
        previousUrl: previous?.url ?? null,
        newUrl: input.url,
      },
    });

    return "ok";
  });
}
