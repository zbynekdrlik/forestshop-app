import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import type { CatalogIngestResult } from "../modules/catalog/ingest.js";
import { catalogStats, getVariant, listSnapshots, searchVariants } from "../modules/catalog/queries.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";

const snapshotsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

const variantsQuery = z.object({
  q: z.string().max(200).default(""),
  state: z.enum(["all", "sellable", "out_of_stock", "discontinued"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const variantParam = z.object({ code: z.string().min(1).max(100) });

export type RunIngest = (now: Date) => Promise<CatalogIngestResult>;

export function registerCatalogRoutes(
  app: Hono<AppBindings>,
  db: Database,
  runIngest: RunIngest | undefined,
): void {
  app.get("/api/catalog/stats", requireUser(db), async (c) => c.json(await catalogStats(db)));

  app.get("/api/catalog/snapshots", requireUser(db), zValidator("query", snapshotsQuery), async (c) =>
    c.json({ items: await listSnapshots(db, c.req.valid("query").limit) }),
  );

  app.get("/api/catalog/variants", requireUser(db), zValidator("query", variantsQuery), async (c) =>
    c.json(await searchVariants(db, c.req.valid("query"))),
  );

  app.get(
    "/api/catalog/variants/:code",
    requireUser(db),
    zValidator("param", variantParam),
    async (c) => {
      const variant = await getVariant(db, c.req.valid("param").code);
      return variant === null ? c.json({ error: "Variant sa nenašiel" }, 404) : c.json(variant);
    },
  );

  app.post("/api/catalog/ingest", requireUser(db), requireRole("admin", "manazer"), async (c) => {
    if (runIngest === undefined) {
      return c.json({ error: "Import katalógu nie je nakonfigurovaný (chýba SHOPTET_EXPORT_URL)" }, 503);
    }
    const now = new Date();
    const user = c.get("user");
    await record(db, {
      at: now,
      actorUserId: user.userId,
      action: "catalog.ingest.trigger",
      entity: "catalog_snapshot",
    });
    const result = await runIngest(now);
    log.info({ actorUserId: user.userId, status: result.status }, "ručný import katalógu");
    return c.json(result);
  });
}
