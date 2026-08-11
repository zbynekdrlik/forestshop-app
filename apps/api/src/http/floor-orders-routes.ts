import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { listFloorOrders } from "../modules/orders/floor-orders-queries.js";
import { requireUser, type AppBindings } from "./middleware.js";

// issue 345: "Eshop → Objednávky predajňa" — LEN čítanie, rovnaké
// oprávnenie ako ostatné zoznamy objednávok (`requireUser`, žiadne
// obmedzenie roly). Prázdna hodnota (`page=`) sa má správať ako neprítomný
// parameter — rovnaký vzor ako `restock-links-routes.ts`'s `pageParam`.
const pageParam = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().min(1).max(100_000).default(1),
);

const floorOrdersQuery = z.object({
  page: pageParam,
  pageSize: z.coerce.number().int().min(1).max(200).default(10),
});

export function registerFloorOrdersRoutes(app: Hono<AppBindings>, db: Database, adminBaseUrl: string): void {
  app.get("/api/floor-orders", requireUser(db), zValidator("query", floorOrdersQuery), async (c) =>
    c.json(await listFloorOrders(db, adminBaseUrl, c.req.valid("query"))),
  );
}
