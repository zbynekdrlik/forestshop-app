import type { Hono } from "hono";
import type { Database } from "../db/client.js";
import { listLatestJobRuns } from "../modules/scheduler/queries.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";

// Rovnaké dve role ako spúšťanie ručného importu katalógu
// (`requireRole("admin", "manazer")`, `catalog-routes.ts`) — tí istí ľudia,
// čo dnes vidia/spúšťajú import ručne, majú vidieť aj to, či nočný beh prešiel.
export function registerSchedulerRoutes(app: Hono<AppBindings>, db: Database): void {
  app.get("/api/scheduler/runs", requireUser(db), requireRole("admin", "manazer"), async (c) =>
    c.json({ items: await listLatestJobRuns(db) }),
  );
}
