import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { listFloorOrders } from "../modules/orders/floor-orders-queries.js";
import { requireUser, type AppBindings } from "./middleware.js";

// issue 345: "Eshop → Objednávky predajňa" — LEN čítanie, rovnaké
// oprávnenie ako ostatné zoznamy objednávok (`requireUser`, žiadne
// obmedzenie roly). Prázdna hodnota (`page=`/`pageSize=`) sa má správať ako
// neprítomný parameter — rovnaký vzor ako `restock-links-routes.ts`'s
// `pageParam` (review finding, issue 345: pôvodne mal len `page` tento
// `z.preprocess`, `pageSize=` bez neho skončí ako `0` → 400, hoci `page=`
// je tolerované — teraz zdieľajú TÚ ISTÚ funkciu).
function emptyToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

const pageParam = z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(100_000).default(1));
const pageSizeParam = z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(200).default(10));

const floorOrdersQuery = z.object({
  page: pageParam,
  pageSize: pageSizeParam,
});

export function registerFloorOrdersRoutes(app: Hono<AppBindings>, db: Database, adminBaseUrl: string): void {
  app.get("/api/floor-orders", requireUser(db), zValidator("query", floorOrdersQuery), async (c) =>
    c.json(await listFloorOrders(db, adminBaseUrl, c.req.valid("query"))),
  );
}
