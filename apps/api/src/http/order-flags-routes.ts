import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { clearOrderClaim, markOrderClaim } from "../modules/orders/order-flags-state.js";
import { countOrderFlags, listClaimOrders, listExchangeOrders, listReturnedOrders } from "../modules/orders/order-flags-queries.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

// issue 290: "Eshop → Výmena tovaru / Vrátený tovar / Reklamácie". Čítanie
// má rovnaké oprávnenie ako zvyšok obrazovky "Na objednanie"/"Nedostupné
// tovary" (`requireUser`, žiadne obmedzenie roly — každý prihlásený
// zamestnanec smie vidieť). Označenie/zrušenie reklamácie MENÍ dáta
// objednávky, rovnaká rola ako ostatné mutácie v `orders-routes.ts`
// (`requireRole("admin", "manazer")`).

const markClaimBody = z.object({
  orderCode: z.string().trim().min(1).max(60),
  note: z.string().trim().max(2000).optional(),
});
const claimIdParam = z.object({ id: z.string().uuid() });

export function registerOrderFlagsRoutes(app: Hono<AppBindings>, db: Database, adminBaseUrl: string): void {
  app.get("/api/order-flags/counts", requireUser(db), async (c) => c.json(await countOrderFlags(db)));

  app.get("/api/order-flags/exchange", requireUser(db), async (c) =>
    c.json({ orders: await listExchangeOrders(db, adminBaseUrl) }),
  );

  app.get("/api/order-flags/returned", requireUser(db), async (c) =>
    c.json({ orders: await listReturnedOrders(db, adminBaseUrl) }),
  );

  app.get("/api/order-flags/claims", requireUser(db), async (c) => c.json({ orders: await listClaimOrders(db, adminBaseUrl) }));

  app.post(
    "/api/order-flags/claims",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", markClaimBody),
    async (c) => {
      const body = c.req.valid("json");
      const result = await markOrderClaim(db, {
        orderCode: body.orderCode,
        note: body.note !== undefined && body.note !== "" ? body.note : null,
        actorUserId: c.get("user").userId,
        now: new Date(),
      });
      if (result.status === "not_found") {
        return c.json({ ok: false, error: "Objednávka s týmto číslom sa nenašla." });
      }
      return c.json({ ok: true, orderId: result.orderId });
    },
  );

  app.post(
    "/api/order-flags/claims/:id/clear",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", claimIdParam),
    async (c) => {
      const { id } = c.req.valid("param");
      const result = await clearOrderClaim(db, { orderId: id, actorUserId: c.get("user").userId, now: new Date() });
      if (result === "not_found") {
        return c.json({ ok: false, error: "Reklamácia sa nenašla — pravdepodobne bola už zrušená." });
      }
      return c.json({ ok: true });
    },
  );
}
