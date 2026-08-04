import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { globalSearch } from "../modules/search/queries.js";
import { requireUser, type AppBindings } from "./middleware.js";

// issue 240: rovnaké oprávnenie ako katalóg/objednávky/párovanie
// (`requireUser`, žiadne obmedzenie roly) — každý prihlásený smie hľadať.
const searchQuery = z.object({ q: z.string().max(200).default("") });

export function registerSearchRoutes(app: Hono<AppBindings>, db: Database, adminBaseUrl: string): void {
  app.get("/api/search", requireUser(db), zValidator("query", searchQuery), async (c) =>
    c.json(await globalSearch(db, c.req.valid("query").q, adminBaseUrl)),
  );
}
