import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { createNote, deleteNote, setNoteResolved } from "../modules/note/service.js";
import { listNotes } from "../modules/note/queries.js";
import { requireSameOrigin } from "./origin-check.js";
import { requireUser, type AppBindings } from "./middleware.js";

// issue 437: "Poznámky" — ZDIEĽANÁ nástenka rýchlych poznámok. Rovnako ako
// `daily-tasks-routes.ts` STAČÍ `requireUser` na KAŽDÚ akciu vrátane zápisu
// (žiadny `requireRole`) — Štěpán (rola `sef`) musí vedieť pridávať aj
// spracúvať, a je to zdieľaný tímový nástroj. Na rozdiel od súkromných úloh
// sa tu vlastníctvo NEvynucuje: ktokoľvek prihlásený vidí/vybaví/zmaže
// akúkoľvek poznámku (ticket: „na spracovanie, nie súkromné").
const createBody = z.object({ body: z.string().trim().min(1).max(2000) });
const resolveBody = z.object({ resolved: z.boolean() });
const idParam = z.object({ id: z.string().uuid() });

export function registerNoteRoutes(app: Hono<AppBindings>, db: Database): void {
  app.get("/api/notes", requireUser(db), async (c) => {
    const rows = await listNotes(db);
    return c.json({ rows });
  });

  app.post("/api/notes", requireSameOrigin(), requireUser(db), zValidator("json", createBody), async (c) => {
    const { body } = c.req.valid("json");
    const user = c.get("user");
    const created = await createNote(db, { authorUserId: user.userId, body, now: new Date() });
    return c.json({ ok: true as const, id: created.id });
  });

  app.post("/api/notes/:id/resolve", requireSameOrigin(), requireUser(db), zValidator("param", idParam), zValidator("json", resolveBody), async (c) => {
    const { id } = c.req.valid("param");
    const { resolved } = c.req.valid("json");
    const updated = await setNoteResolved(db, { id, resolved, now: new Date() });
    return c.json({ ok: true as const, updated });
  });

  app.delete("/api/notes/:id", requireSameOrigin(), requireUser(db), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const removed = await deleteNote(db, { id });
    return c.json({ ok: true as const, removed });
  });
}
