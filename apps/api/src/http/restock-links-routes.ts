import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { listRestockLinkSuggestions } from "../modules/restock-links/queries.js";
import { requireUser, type AppBindings } from "./middleware.js";

// Prázdna hodnota (`page=`) sa má správať ako neprítomný parameter, rovnaký
// vzor ako `product-links-routes.ts`'s `pageParam`.
const pageParam = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().min(1).max(100_000).default(1),
);

const restockLinksQuery = z.object({
  q: z.string().max(200).default(""),
  page: pageParam,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// issue 311: LEN čítanie — zápis potvrdeného odkazu ide cez UŽ existujúcu
// `POST /api/product-links/:productKey` (#239, `product-links-routes.ts`),
// žiadna nová zapisovacia trasa.
export function registerRestockLinksRoutes(app: Hono<AppBindings>, db: Database): void {
  app.get("/api/restock-links", requireUser(db), zValidator("query", restockLinksQuery), async (c) =>
    c.json(await listRestockLinkSuggestions(db, c.req.valid("query"))),
  );
}
