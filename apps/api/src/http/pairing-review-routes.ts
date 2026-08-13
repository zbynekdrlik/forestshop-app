import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { listPairingReview } from "../modules/pairing-review/queries.js";
import { requireUser, type AppBindings } from "./middleware.js";

// issue 387 E5: "Eshop → Párovanie" — LEN čítanie (karty + filtre nad tým, čo
// E3/E4 zozbierali a overili). Rozhodnutia/zápis prídu až v E6 — žiadna
// POST trasa tu.

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

export function registerPairingReviewRoutes(app: Hono<AppBindings>, db: Database): void {
  // Rovnaké oprávnenie ako `restock-links`/`product-links` čítanie
  // (`requireUser`, žiadne rolové obmedzenie) — každý prihlásený smie vidieť
  // stav párovania.
  app.get("/api/pairing-review", requireUser(db), zValidator("query", pairingReviewQuery), async (c) =>
    c.json(await listPairingReview(db, c.req.valid("query"))),
  );
}
