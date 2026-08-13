import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { orderLines, productSupplierLinkOverrides, products, variants } from "../../db/schema.js";
import { record } from "../audit/service.js";
import { startsWithFormulaChar } from "../shoptet-writeback/formula-guard.js";

export type SetProductSupplierLinkResult = "ok" | "not_found";

export interface SetProductSupplierLinkInput {
  readonly lineId: string;
  // Už orezané + validované ako URL — `zValidator` na HTTP hranici
  // (`z.string().trim().url()`, `orders-routes.ts`).
  readonly url: string;
  readonly actorUserId: string;
  readonly now: Date;
}

// issue 239: zdieľaná zod schéma pre TELO "ulož odkaz na dodávateľa" — dnes
// dve trasy (`POST /api/orders/lines/:lineId/supplier-link` z #121 a
// `POST /api/product-links/:productKey` z #239), obe overujú TÚ ISTÚ vec
// (URL, http(s) schéma, žiadny formula-injection znak na začiatku, #153).
// Predtým bola definovaná len lokálne v `orders-routes.ts` — presunuté sem,
// aby ju nová trasa nemusela duplikovať/rozísť sa s ňou.
export const supplierLinkUrlBody = z.object({
  url: z
    .string()
    .trim()
    .url()
    .max(2000)
    .regex(/^https?:\/\//)
    .refine((v) => !startsWithFormulaChar(v), {
      message: "odkaz nesmie začínať znakom vzorca (=, +, -, @) — možný pokus o CSV-injection",
    }),
});

// Zúžený parameter (rovnaký vzor ako `audit/service.ts`'s `AuditExecutor`,
// `.claude/rules/database.md`) — musí bežať aj s `tx` (`PgTransaction`),
// ktorý zdieľa `.select()`/`.insert()` s `Database`, ale nemá jej `$client`.
export type UpsertExecutor = Pick<Database, "select" | "insert">;

export interface UpsertProductSupplierLinkInput {
  readonly productKey: string;
  readonly url: string;
  readonly actorUserId: string;
  readonly now: Date;
  // `null` keď zápis nejde cez konkrétny riadok objednávky (issue 239's
  // `setProductSupplierLinkForProduct` — produkt bez otvorenej objednávky).
  readonly lineId: string | null;
}

// Zdieľané jadro VŠETKÝCH zápisových ciest nižšie/inde (`setProductSupplierLink`
// cez `lineId`, `setProductSupplierLinkForProduct` cez priamy `productKey`,
// issue 387 E6's `pairing-review/decisions.ts` cez VLASTNÚ transakciu, keď
// treba `pairing_decision` upsert + túto linku zapísať ATOMICKY spolu) —
// rovnaký upsert + audit záznam. Exportované (issue 387 E6) presne preto,
// aby VLASTNÁ transakcia mohla toto jadro zavolať s SVOJÍM `tx`, namiesto
// volania `setProductSupplierLinkForProduct` (tá by otvorila DRUHÚ,
// vnorenú transakciu).
export async function upsertProductSupplierLink(
  tx: UpsertExecutor,
  input: UpsertProductSupplierLinkInput,
): Promise<"ok"> {
  const [previous] = await tx
    .select({ url: productSupplierLinkOverrides.url })
    .from(productSupplierLinkOverrides)
    .where(eq(productSupplierLinkOverrides.productKey, input.productKey))
    .limit(1);

  await tx
    .insert(productSupplierLinkOverrides)
    .values({ productKey: input.productKey, url: input.url, updatedAt: input.now })
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
    entityId: input.productKey,
    data: {
      productKey: input.productKey,
      lineId: input.lineId,
      previousUrl: previous?.url ?? null,
      newUrl: input.url,
    },
  });

  return "ok";
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

    return upsertProductSupplierLink(tx, {
      productKey: line.productKey,
      url: input.url,
      actorUserId: input.actorUserId,
      now: input.now,
      lineId: input.lineId,
    });
  });
}

export type SetProductSupplierLinkForProductResult = "ok" | "not_found";

export interface SetProductSupplierLinkForProductInput {
  readonly productKey: string;
  readonly url: string;
  readonly actorUserId: string;
  readonly now: Date;
}

// issue 239: priamy náprotivok `setProductSupplierLink` vyššie, PRE PRODUKT
// bez sprostredkovania cez konkrétny riadok objednávky — obrazovka "Eshop →
// Párovanie produktov" vypisuje produkty (aj tie BEZ otvorenej objednávky),
// takže potrebuje zapisovať priamo podľa `productKey`, nie `lineId`. Zdieľa
// rovnaké jadro (`upsertProductSupplierLink`) s `setProductSupplierLink` —
// jediný rozdiel je, ako sa `productKey` overí (tu priamo cez `products`
// tabuľku, nie cez JOIN na `orderLines`/`variants`).
export async function setProductSupplierLinkForProduct(
  db: Database,
  input: SetProductSupplierLinkForProductInput,
): Promise<SetProductSupplierLinkForProductResult> {
  return db.transaction(async (tx) => {
    const [product] = await tx.select({ key: products.key }).from(products).where(eq(products.key, input.productKey)).limit(1);
    if (product === undefined) return "not_found";

    return upsertProductSupplierLink(tx, {
      productKey: input.productKey,
      url: input.url,
      actorUserId: input.actorUserId,
      now: input.now,
      lineId: null,
    });
  });
}
