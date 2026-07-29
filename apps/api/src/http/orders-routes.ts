import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { ORDERS_EXPORT_URL_NOT_CONFIGURED, type OrdersIngestResult, type RunOrdersIngest } from "../modules/orders/ingest.js";
import { getOrderDetail, listOpenOrderLinesBySupplier } from "../modules/orders/queries.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

const orderParam = z.object({ id: z.string().uuid() });

// Re-exportované, aby `http/app.ts` nemusel meniť svoj import — kanonická
// definícia žije v `modules/orders/ingest.ts` (rovnaký vzor ako katalógov
// `RunIngest` re-export v `catalog-routes.ts`).
export type { RunOrdersIngest };

export function registerOrdersRoutes(
  app: Hono<AppBindings>,
  db: Database,
  runOrdersIngest: RunOrdersIngest | undefined,
): void {
  // Čítacie trasy — rovnaké oprávnenie ako katalógové čítanie
  // (`requireUser`, žiadne obmedzenie roly): každý prihlásený používateľ smie
  // vidieť otvorené objednávky, len SPÚŠŤANIE importu (nižšie) je vyhradené.
  app.get("/api/orders/open", requireUser(db), async (c) =>
    c.json({ suppliers: await listOpenOrderLinesBySupplier(db) }),
  );

  app.get("/api/orders/:id", requireUser(db), zValidator("param", orderParam), async (c) => {
    const detail = await getOrderDetail(db, c.req.valid("param").id);
    if (detail === null) return c.json({ error: "Objednávka sa nenašla" }, 404);
    return c.json(detail);
  });

  // JEDEN import naraz — rovnaký in-flight guard ako `/api/catalog/ingest`
  // (uzáver na inštanciu aplikácie, `createApp`/`registerOrdersRoutes` sa
  // volá raz za proces).
  let ingestInFlight = false;

  app.post(
    "/api/orders/ingest",
    // Rovnaká CSRF disciplína ako `/api/catalog/ingest` — stavovo-meniaca
    // požiadavka nad autentifikovaným cookie session-om.
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    async (c) => {
      if (runOrdersIngest === undefined) {
        return c.json({ error: ORDERS_EXPORT_URL_NOT_CONFIGURED }, 503);
      }
      if (ingestInFlight) {
        return c.json({ status: "busy" as const });
      }
      ingestInFlight = true;
      try {
        const now = new Date();
        const user = c.get("user");
        let result: OrdersIngestResult;
        try {
          result = await runOrdersIngest(now);
        } catch (error) {
          // Stiahnutie exportu zlyhalo úplne — rovnaká disciplína ako
          // katalógov ekvivalent (`catalog-routes.ts`): surová chyba sa
          // loguje samostatne, nikdy sa neinterpoluje do hlášky pre
          // operátora ani do auditového záznamu.
          const rawErrorMessage = error instanceof Error ? error.message : String(error);
          log.error(
            { actorUserId: user.userId, rawErrorMessage },
            "stiahnutie exportu objednávok zlyhalo",
          );
          await record(db, {
            at: now,
            actorUserId: user.userId,
            action: "orders.ingest.trigger",
            entity: "order",
            data: { status: "fetch_failed" },
          });
          return c.json(
            { error: "Export objednávok zo Shoptetu sa nepodarilo stiahnuť. Skúste import o chvíľu zopakovať." },
            502,
          );
        }
        // Audit sa zapisuje PO dobehnutí importu, nie pred ním — nesie tak
        // skutočný výsledok, nielen úmysel ho spustiť (rovnaký vzor ako
        // katalóg). Dáta sú ZÚŽENÉ (nie celý `result`) — rovnaká disciplína
        // ako katalógov `{ status, snapshotId }`: `rawPath` je cesta na
        // serverovom disku, do audit záznamu (čitateľného cez API) nepatrí.
        await record(db, {
          at: now,
          actorUserId: user.userId,
          action: "orders.ingest.trigger",
          entity: "order",
          data:
            result.status === "accepted"
              ? { status: result.status, orderCount: result.orderCount, lineCount: result.lineCount }
              : { status: result.status, reason: result.reason },
        });
        log.info({ actorUserId: user.userId, status: result.status }, "ručný import objednávok");
        return c.json(result);
      } finally {
        ingestInFlight = false;
      }
    },
  );
}
