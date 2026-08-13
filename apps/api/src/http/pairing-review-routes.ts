import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { supplierLinkUrlBody } from "../modules/orders/supplier-link-assignment.js";
import { setPairingDecision } from "../modules/pairing-review/decisions.js";
import { listPairingCandidatesForProduct, listPairingReview } from "../modules/pairing-review/queries.js";
import { isStateWritebackEnabled, setStateWritebackEnabled } from "../modules/shoptet-writeback/state-writeback-settings.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

// issue 387 E5: "Eshop → Párovanie" — čítanie (karty + filtre nad tým, čo
// E3/E4 zozbierali a overili). issue 387 E6: pridáva rozhodnutia (POST) +
// lazy zoznam kandidátov pre panel (GET) — rovnaké oprávnenie ako
// `product-links-routes.ts`'s zápisová trasa (`requireRole("admin",
// "manazer")` + `requireSameOrigin()`). issue 387 E7: pridáva Štart/Stop
// prepínač pre STAVOVÝ writeback (mení viditeľnosť produktov na živom
// shope) — rovnaké miesto ako zvyšok obrazovky Párovanie, rovnaký vzor ako
// existujúca `PUT /api/pairing-search/enabled`.

// Prázdna hodnota (`page=`) sa má správať ako neprítomný parameter, rovnaký
// vzor ako `restock-links-routes.ts`/`product-links-routes.ts`'s `pageParam`.
const pageParam = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().min(1).max(100_000).default(1),
);

const pairingReviewQuery = z.object({
  filter: z.enum(["unreviewed", "matched", "unmatched", "st1", "st2", "st3", "decided", "terminal", "all"]).default("unreviewed"),
  page: pageParam,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// `productKey` je export's `guid` (rovnaký komentár ako `product-links-
// routes.ts`'s `productLinkParam`) — bezpečné ako cestový segment.
const pairingReviewProductParam = z.object({ productKey: z.string().min(1).max(200) });

// issue 387 E6 — diskriminovaná únia presne podľa design komentára:
// `good` nenesie žiadne telo (server sám dohľadá `chosenUrl`), `manual`
// nesie `url` (zdieľaná zod validácia `supplierLinkUrlBody`, rovnaká ako
// `product-links`), zvyšné tri nenesú nič.
const pairingDecisionBody = z.discriminatedUnion("status", [
  z.object({ status: z.literal("good") }),
  z.object({ status: z.literal("manual"), url: supplierLinkUrlBody.shape.url }),
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("discontinued") }),
  z.object({ status: z.literal("revert") }),
]);

const setStateWritebackEnabledBody = z.object({ enabled: z.boolean() });

export function registerPairingReviewRoutes(app: Hono<AppBindings>, db: Database): void {
  // issue 387 E7 — `/api/pairing-review/state-writeback-enabled` má INÝ
  // segmentový tvar než `:productKey/candidates`/`:productKey/decision`
  // nižšie (2 segmenty za prefixom, nie `:productKey` + ďalší literál), takže
  // tu nehrozí `.claude/rules/http-routes.md`'s literal-vs-`:param` kolízia —
  // ponechané na tomto mieste kvôli tematickému zoskupeniu (Štart/Stop je
  // súčasťou tej istej obrazovky Párovanie).
  app.get("/api/pairing-review/state-writeback-enabled", requireUser(db), async (c) =>
    c.json({ enabled: await isStateWritebackEnabled(db) }),
  );

  app.put(
    "/api/pairing-review/state-writeback-enabled",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", setStateWritebackEnabledBody),
    async (c) => {
      const { enabled } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      await setStateWritebackEnabled(db, enabled, now);
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "pairing_state_writeback.enabled.set",
        entity: "pairing_state_writeback_settings",
        data: { enabled },
      });
      log.info({ actorUserId: user.userId, enabled }, "Párovanie: Štart/Stop stavového writebacku");
      return c.json({ ok: true as const, enabled });
    },
  );

  // Rovnaké oprávnenie ako `restock-links`/`product-links` čítanie
  // (`requireUser`, žiadne rolové obmedzenie) — každý prihlásený smie vidieť
  // stav párovania.
  app.get("/api/pairing-review", requireUser(db), zValidator("query", pairingReviewQuery), async (c) =>
    c.json(await listPairingReview(db, c.req.valid("query"))),
  );

  // issue 387 E6 — lazy top-8 kandidátov pre rozhodovací panel (design
  // komentár: volané AŽ pri otvorení panelu, nikdy vložené do hlavného
  // zoznamu). Rovnaké oprávnenie ako čítanie vyššie — panel smie OTVORIŤ
  // ktokoľvek prihlásený, akčné tlačidlá vnútri sa gatujú na frontende podľa
  // roly a POST nižšie ich aj tak vyžaduje.
  app.get(
    "/api/pairing-review/:productKey/candidates",
    requireUser(db),
    zValidator("param", pairingReviewProductParam),
    async (c) => c.json({ candidates: await listPairingCandidatesForProduct(db, c.req.valid("param").productKey) }),
  );

  // issue 387 E6 — rozhodnutie. Rovnaké oprávnenie ako existujúci `POST
  // /api/product-links/:productKey` (#239): `requireRole("admin","manazer")`.
  app.post(
    "/api/pairing-review/:productKey/decision",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", pairingReviewProductParam),
    zValidator("json", pairingDecisionBody),
    async (c) => {
      const { productKey } = c.req.valid("param");
      const body = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();

      const result = await setPairingDecision(db, { ...body, productKey, actorUserId: user.userId, now });
      if (result === "not_found") return c.json({ error: "Produkt sa nenašiel" }, 404);
      if (result === "no_candidate") return c.json({ error: "Tento produkt nemá navrhnutého kandidáta na potvrdenie" }, 400);

      log.info({ actorUserId: user.userId, productKey, status: body.status }, "rozhodnutie o párovaní produktu");
      return c.json({ ok: true as const, status: body.status });
    },
  );
}
