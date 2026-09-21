import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { orderLineState } from "../db/schema.js";
import {
  attachFloorNoteProduct,
  createFloorNote,
  deleteFloorNote,
  detachFloorNoteProduct,
  setFloorNoteCalled,
  setFloorNoteOrdered,
  setFloorNoteProductComment,
  setFloorNoteProductOrdered,
  setFloorNoteProductState,
  setFloorNoteResolved,
  updateFloorNoteProductQuantity,
  updateFloorNoteText,
} from "../modules/floor-notes/service.js";
import { countUnresolvedFloorNotes, listFloorNotes } from "../modules/floor-notes/queries.js";
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
// issue 575: stav položky — čerpaný priamo z `orderLineState.enumValues`
// (ZDIEĽANÝ zdroj pravdy s e-shopovou objednávkou, `orders-routes.ts`'s
// `orderLineStateBody`), takže nová hodnota enumu sa prejaví na oboch trasách
// bez rizika rozídenia.
const stateBody = z.object({ state: z.enum(orderLineState.enumValues) });
// issue 575: per-položková poznámka — trim + strop (rovnaký vzor ako
// `orderCommentBody`, `orders-routes.ts`). Prázdny reťazec = zmazať poznámku,
// service ho normalizuje na `null`.
const commentBody = z.object({ comment: z.string().trim().max(2000) });
const idParam = z.object({ id: z.string().uuid() });
const productParam = z.object({ id: z.string().uuid(), variantCode: z.string() });

export function registerFloorNotesRoutes(app: Hono<AppBindings>, db: Database): void {
  app.get("/api/floor-notes", requireUser(db), async (c) => {
    const rows = await listFloorNotes(db);
    return c.json({ rows });
  });

  // issue 473: odznak počtu v ľavom menu — počet nevybavených (`resolved=false`)
  // zápisov, globálne. Literal-path súrodenec MUSÍ byť pred `/:id` trasami
  // (`.claude/rules/http-routes.md` — poradie literal-vs-`:param`); dnes žiadna
  // GET `/:id` trasa neexistuje, ale poradie sa drží ako zvyk (rovnako ako
  // `upozornenia-routes.ts`'s `/count`).
  app.get("/api/floor-notes/count", requireUser(db), async (c) => {
    const count = await countUnresolvedFloorNotes(db);
    return c.json({ count });
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

  // issue 480: „objednané" na predajňovom riadku v board-e „Na objednanie" —
  // nastaví `floor_note_product.ordered_at` a prepočíta note-level 🛒
  // (`setFloorNoteProductOrdered`). Rovnaké oprávnenie + CSRF disciplína ako
  // ostatné zápisy. 6-segmentová trasa (`.../products/:variantCode/ordered`) sa
  // NEKOLÍDUJE so 4-segmentovým `POST .../products` (attach) ani s
  // 5-segmentovým `DELETE .../:variantCode` (iný počet segmentov / iná metóda,
  // `.claude/rules/http-routes.md`).
  app.post(
    "/api/floor-notes/:id/products/:variantCode/ordered",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", productParam),
    zValidator("json", markerBody),
    async (c) => {
      const { id, variantCode } = c.req.valid("param");
      const { value } = c.req.valid("json");
      const user = c.get("user");
      const result = await setFloorNoteProductOrdered(db, {
        floorNoteId: id,
        variantCode,
        ordered: value,
        actorUserId: user.userId,
        now: new Date(),
      });
      if (result === "not_found") {
        return c.json({ error: "Položka zápisu sa nenašla" }, 404);
      }
      return c.json({ ok: true as const, ordered: value });
    },
  );

  // issue 575: stav položky v board-e „Na objednanie" — rovnaké možnosti ako
  // e-shopová objednávka (Nemáme / Riešiť / Čaká sa / Skladom / Nedostupné /
  // Objednané). 6-segmentová trasa (`.../products/:variantCode/state`) sa
  // nekolíduje s ostatnými (iný posledný literál / iná metóda,
  // `.claude/rules/http-routes.md`). Rovnaké oprávnenie + CSRF disciplína.
  app.post(
    "/api/floor-notes/:id/products/:variantCode/state",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", productParam),
    zValidator("json", stateBody),
    async (c) => {
      const { id, variantCode } = c.req.valid("param");
      const { state } = c.req.valid("json");
      const user = c.get("user");
      const result = await setFloorNoteProductState(db, {
        floorNoteId: id,
        variantCode,
        state,
        actorUserId: user.userId,
        now: new Date(),
      });
      if (result === "not_found") {
        return c.json({ error: "Položka zápisu sa nenašla" }, 404);
      }
      return c.json({ ok: true as const, state });
    },
  );

  // issue 575: per-položková poznámka. Prázdny reťazec (po orezaní) sa
  // normalizuje na `null` (rovnaký vzor ako `PUT /api/orders/:id/comment`).
  app.patch(
    "/api/floor-notes/:id/products/:variantCode/comment",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", productParam),
    zValidator("json", commentBody),
    async (c) => {
      const { id, variantCode } = c.req.valid("param");
      const { comment } = c.req.valid("json");
      const user = c.get("user");
      const normalizedComment = comment === "" ? null : comment;
      const result = await setFloorNoteProductComment(db, {
        floorNoteId: id,
        variantCode,
        comment: normalizedComment,
        actorUserId: user.userId,
        now: new Date(),
      });
      if (result === "not_found") {
        return c.json({ error: "Položka zápisu sa nenašla" }, 404);
      }
      return c.json({ ok: true as const, comment: normalizedComment });
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
