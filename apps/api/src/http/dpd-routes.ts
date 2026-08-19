import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import type { DpdPortalConfig } from "../modules/dpd/config.js";
import type { OrderDpdPickupOutcome, RunOrderDpdPickupOptions } from "../modules/dpd/pickup-playwright.js";
import { runOrderDpdPickupIsolated } from "../modules/dpd/pickup-playwright.js";
import { countDpdShippableOrders, getDpdShipmentPreviews, listDpdShippableOrders } from "../modules/dpd/queries.js";
import { recordDpdPickupRequest, recordDpdShipmentFailure, recordDpdShipmentSuccess } from "../modules/dpd/record.js";
import type { CreateDpdShipmentOutcome, RunCreateDpdShipmentOptions } from "../modules/dpd/shipment-playwright.js";
import { runCreateDpdShipmentIsolated } from "../modules/dpd/shipment-playwright.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

// HTTP vrstva dodá `db`; prihlasovacie údaje do DPD portálu zostavuje
// `index.ts` raz pri štarte (rovnaký vzor ako `restock-routes.ts`'s
// `RestockRunDeps`) — `config: undefined` = appka beží ďalej, len akcie
// odosielajúce do DPD vrátia 503 "nenakonfigurované". `createShipment`/
// `orderPickup` sú INJEKTOVANÉ (predvolene skutočný izolovaný Playwright
// robot) presne z rovnakého dôvodu ako `postaUncollected.trackingClient`/
// `nedostupne.mailTransport` — testy nahradia falošnou implementáciou a
// NIKDY sa nedotknú reálneho DPD účtu ani nespustia skutočný Chromium.
export interface DpdRunDeps {
  readonly config: DpdPortalConfig | undefined;
  readonly createShipment?: (options: RunCreateDpdShipmentOptions) => Promise<CreateDpdShipmentOutcome>;
  readonly orderPickup?: (options: RunOrderDpdPickupOptions) => Promise<OrderDpdPickupOutcome>;
}

const orderIdsBody = z.object({
  orderIds: z.array(z.string().uuid()).min(1).max(50),
  // Kľúč = `orderId`, hodnota = obsluhou upravená hmotnosť (kg, desatinná
  // BODKA — appka ju z UI dostáva už normalizovanú, nie Shoptet-ovu čiarku).
  weightOverrides: z.record(z.string().uuid(), z.string().regex(/^\d+(\.\d{1,2})?$/)).optional(),
});

const pickupBody = z.object({ pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

function toWeightOverrides(raw: Record<string, string> | undefined): Map<string, string> {
  return new Map(Object.entries(raw ?? {}));
}

const NOT_CONFIGURED_MESSAGE = "DPD preprava nie je nakonfigurovaná (chýba DPD_PORTAL_USER/DPD_PORTAL_PASSWORD)";

export function registerDpdRoutes(app: Hono<AppBindings>, db: Database, deps: DpdRunDeps): void {
  const createShipment = deps.createShipment ?? runCreateDpdShipmentIsolated;
  const orderPickup = deps.orderPickup ?? runOrderDpdPickupIsolated;
  app.get("/api/dpd/orders", requireUser(db), async (c) => {
    const orders = await listDpdShippableOrders(db);
    return c.json({ configured: deps.config !== undefined, orders });
  });

  // issue 445: lacný počet pre nav badge — literal-path súrodenec MUSÍ byť
  // pred akoukoľvek budúcou `/api/dpd/orders/:id` trasou rovnakej metódy
  // (`.claude/rules/http-routes.md`), dnes žiadna taká nie je, poradie sa
  // drží ako zvyk.
  app.get("/api/dpd/orders/count", requireUser(db), async (c) => {
    const count = await countDpdShippableOrders(db);
    return c.json({ count });
  });

  app.post("/api/dpd/preview", requireSameOrigin(), requireUser(db), zValidator("json", orderIdsBody), async (c) => {
    const { orderIds, weightOverrides } = c.req.valid("json");
    const previews = await getDpdShipmentPreviews(db, orderIds, toWeightOverrides(weightOverrides));
    return c.json({ previews });
  });

  // issue 292: appka NIKDY neodošle objednávku, ktorej adresa je neúplná —
  // taký riadok sa vráti ako `skipped`, nikdy sa neposiela robotovi (ten by
  // len narazil na prázdne polia). Skutočné odoslanie je vždy per-objednávka
  // (nie jeden hromadný beh) — jedno zlyhanie NESMIE zablokovať úspech
  // ostatných, rovnaká disciplína ako `shoptet-writeback`'s per-objednávkový
  // zápis poznámky (`.claude/rules/orders.md`).
  app.post(
    "/api/dpd/shipments",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", orderIdsBody),
    async (c) => {
      const { config } = deps;
      if (config === undefined) return c.json({ error: NOT_CONFIGURED_MESSAGE }, 503);

      const { orderIds, weightOverrides } = c.req.valid("json");
      const previews = await getDpdShipmentPreviews(db, orderIds, toWeightOverrides(weightOverrides));
      const user = c.get("user");

      const results = await Promise.all(
        previews.map(async (shipment) => {
          if (!shipment.addressComplete) {
            return { orderId: shipment.orderId, ok: false as const, error: "Chýba doručovacia adresa" };
          }
          try {
            const outcome = await createShipment({ config, shipment });
            const attempt = { orderId: shipment.orderId, weightKg: shipment.weightKg, codAmount: shipment.codAmount };
            if (outcome.ok && outcome.parcelNumber !== null) {
              await recordDpdShipmentSuccess(db, attempt, outcome.parcelNumber);
              await record(db, {
                at: new Date(),
                actorUserId: user.userId,
                action: "dpd.shipment.created",
                entity: "dpd_shipment",
                entityId: shipment.orderId,
                data: { externalOrderId: shipment.externalOrderId, parcelNumber: outcome.parcelNumber },
              });
              return { orderId: shipment.orderId, ok: true as const, parcelNumber: outcome.parcelNumber };
            }
            const errorDetail = outcome.errorDetail ?? "Neznáma chyba";
            await recordDpdShipmentFailure(db, attempt, errorDetail);
            return { orderId: shipment.orderId, ok: false as const, error: errorDetail };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.error({ err: message, externalOrderId: shipment.externalOrderId }, "DPD zásielka: neočakávaná chyba");
            await recordDpdShipmentFailure(db, { orderId: shipment.orderId, weightKg: shipment.weightKg, codAmount: shipment.codAmount }, message);
            return { orderId: shipment.orderId, ok: false as const, error: message };
          }
        }),
      );
      return c.json({ results });
    },
  );

  app.post(
    "/api/dpd/pickup-orders",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", pickupBody),
    async (c) => {
      const { config } = deps;
      if (config === undefined) return c.json({ error: NOT_CONFIGURED_MESSAGE }, 503);

      const { pickupDate } = c.req.valid("json");
      const user = c.get("user");
      let outcome: { readonly ok: boolean; readonly errorDetail: string | null };
      try {
        outcome = await orderPickup({ config, pickupDate });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome = { ok: false, errorDetail: message };
      }
      await recordDpdPickupRequest(db, { pickupDate, status: outcome.ok ? "submitted" : "failed", errorMessage: outcome.errorDetail });
      if (outcome.ok) {
        await record(db, {
          at: new Date(),
          actorUserId: user.userId,
          action: "dpd.pickup.requested",
          entity: "dpd_pickup_request",
          data: { pickupDate },
        });
      }
      log.info({ actorUserId: user.userId, pickupDate, ok: outcome.ok }, "DPD zvoz: pokus");
      return c.json({ ok: outcome.ok, error: outcome.errorDetail });
    },
  );
}
