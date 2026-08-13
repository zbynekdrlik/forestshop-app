import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { supplierLinkUrlBody } from "../modules/orders/supplier-link-assignment.js";
import { setPairingDecision } from "../modules/pairing-review/decisions.js";
import { listPairingCandidatesForProduct, listPairingReview } from "../modules/pairing-review/queries.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

// issue 387 E5: "Eshop → Párovanie" — čítanie (karty + filtre nad tým, čo
// E3/E4 zozbierali a overili). issue 387 E6: pridáva rozhodnutia (POST) +
// lazy zoznam kandidátov pre panel (GET) — rovnaké oprávnenie ako
// `product-links-routes.ts`'s zápisová trasa (`requireRole("admin",
// "manazer")` + `requireSameOrigin()`).

// Prázdna hodnota (`page=`) sa má správať ako neprítomný parameter, rovnaký
// vzor ako `restock-links-routes.ts`/`product-links-routes.ts`'s `pageParam`.
const pageParam = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().min(1).max(100_000).default(1),
);

const pairingReviewQuery = z.object({
  filter: z.enum(["unreviewed", "matched", "unmatched", "st1", "st2", "st3", "all"]).default("unreviewed"),
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

export function registerPairingReviewRoutes(app: Hono<AppBindings>, db: Database): void {
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
