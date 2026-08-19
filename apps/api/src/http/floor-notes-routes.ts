import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import {
  attachFloorNoteProduct,
  createFloorNote,
  deleteFloorNote,
  detachFloorNoteProduct,
  setFloorNoteCalled,
  setFloorNoteOrdered,
  setFloorNoteResolved,
  updateFloorNoteProductQuantity,
  updateFloorNoteText,
} from "../modules/floor-notes/service.js";
import { listFloorNotes } from "../modules/floor-notes/queries.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

// issue 410: "Eshop → Objednávky predajňa" — nahrádza Shoptet-viazané
// `floor-orders-routes.ts`. Čítanie = ktokoľvek prihlásený (rovnaká úroveň
// ako predtým, ako aj `upozornenia`'s čítanie); zápis (vytvoriť/upraviť/
// zmazať/prepnúť značku/pripnúť-odopnúť produkt) = `requireRole("admin",
// "manazer")` — TEN ISTÝ vzor, aký používa 53+ iných zapisovacích trás v
// tejto appke (`.claude/rules/database.md` nehovorí o tomto explicitne, ale
// grep cez `apps/api/src/http/*.ts` potvrdzuje konzistentný štandard).
const createBody = z.object({ text: z.string().trim().min(1).max(4000) });
const updateTextBody = createBody;
const markerBody = z.object({ value: z.boolean() });
// issue 453: počet kusov — celé číslo ≥ 1, default 1 (spätná kompatibilita:
// starší frontend pole neposiela). `.max` bráni pretečeniu PG `integer`.
const quantitySchema = z.number().int().min(1).max(1_000_000);
const attachBody = z.object({ variantCode: z.string().trim().min(1).max(100), quantity: quantitySchema.default(1) });
const quantityBody = z.object({ quantity: quantitySchema });
const idParam = z.object({ id: z.string().uuid() });
const productParam = z.object({ id: z.string().uuid(), variantCode: z.string() });

export function registerFloorNotesRoutes(app: Hono<AppBindings>, db: Database): void {
  app.get("/api/floor-notes", requireUser(db), async (c) => {
    const rows = await listFloorNotes(db);
    return c.json({ rows });
  });

  app.post("/api/floor-notes", requireSameOrigin(), requireUser(db), requireRole("admin", "manazer"), zValidator("json", createBody), async (c) => {
    const { text } = c.req.valid("json");
    const user = c.get("user");
    const created = await createFloorNote(db, { text, createdByUserId: user.userId, now: new Date() });
    return c.json({ ok: true as const, id: created.id });
  });

  app.patch(
    "/api/floor-notes/:id/text",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", idParam),
    zValidator("json", updateTextBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const { text } = c.req.valid("json");
      const updated = await updateFloorNoteText(db, { id, text, now: new Date() });
      return c.json({ ok: true as const, updated });
    },
  );

  app.post(
    "/api/floor-notes/:id/resolved",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", idParam),
    zValidator("json", markerBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const { value } = c.req.valid("json");
      const updated = await setFloorNoteResolved(db, { id, value, now: new Date() });
      return c.json({ ok: true as const, updated });
    },
  );

  app.post(
    "/api/floor-notes/:id/ordered",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", idParam),
    zValidator("json", markerBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const { value } = c.req.valid("json");
      const updated = await setFloorNoteOrdered(db, { id, value, now: new Date() });
      return c.json({ ok: true as const, updated });
    },
  );

  app.post(
    "/api/floor-notes/:id/called",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", idParam),
    zValidator("json", markerBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const { value } = c.req.valid("json");
      const updated = await setFloorNoteCalled(db, { id, value, now: new Date() });
      return c.json({ ok: true as const, updated });
    },
  );

  app.post(
    "/api/floor-notes/:id/products",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", idParam),
    zValidator("json", attachBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const { variantCode, quantity } = c.req.valid("json");
      const result = await attachFloorNoteProduct(db, { floorNoteId: id, variantCode, quantity, now: new Date() });
      if (!result.ok) {
        const message = result.error === "note_not_found" ? "Zápis sa nenašiel" : "Produkt sa nenašiel";
        return c.json({ error: message }, 404);
      }
      return c.json({ ok: true as const });
    },
  );

  app.patch(
    "/api/floor-notes/:id/products/:variantCode/quantity",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", productParam),
    zValidator("json", quantityBody),
    async (c) => {
      const { id, variantCode } = c.req.valid("param");
      const { quantity } = c.req.valid("json");
      const updated = await updateFloorNoteProductQuantity(db, { floorNoteId: id, variantCode, quantity });
      return c.json({ ok: true as const, updated });
    },
  );

  app.delete(
    "/api/floor-notes/:id/products/:variantCode",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", productParam),
    async (c) => {
      const { id, variantCode } = c.req.valid("param");
      const removed = await detachFloorNoteProduct(db, { floorNoteId: id, variantCode });
      return c.json({ ok: true as const, removed });
    },
  );

  app.delete("/api/floor-notes/:id", requireSameOrigin(), requireUser(db), requireRole("admin", "manazer"), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const removed = await deleteFloorNote(db, { id });
    return c.json({ ok: true as const, removed });
  });
}
