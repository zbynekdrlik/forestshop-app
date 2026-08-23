import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { createDailyTask, deleteDailyTask, setDailyTaskDone, updateDailyTaskEmoji, updateDailyTaskText } from "../modules/daily-tasks/service.js";
import { countOpenDailyTasks, listDailyTasks } from "../modules/daily-tasks/queries.js";
import { requireSameOrigin } from "./origin-check.js";
import { requireUser, type AppBindings } from "./middleware.js";

// issue 342: "Úlohy na dnes" — súkromný zoznam, viazaný na prihláseného
// používateľa. Na rozdiel od zvyšku appky (zápis vyžaduje `requireRole
// ("admin", "manazer")`) tu STAČÍ `requireUser` na KAŽDÚ akciu vrátane
// zápisu — server aj tak vynucuje `userId` na každom dopyte, takže žiadna
// rola nedostane prístup k CUDZÍM úlohám; obmedzenie roly by tu len bránilo
// zamestnancovi s rolou "citanie" mať VLASTNÝ súkromný zoznam bez dôvodu.
const createBody = z.object({ text: z.string().trim().min(1).max(300) });
const updateTextBody = z.object({ text: z.string().trim().min(1).max(300) });
// Code review: 16 znakov by odmietlo legitímnu VIACPRVKOVÚ emoji sekvenciu
// (rodinné/kožný odtieň kombinácie spájané ZWJ znakom môžu ľahko presiahnuť
// 16 UTF-16 jednotiek) — 32 dáva dosť priestoru aj pre takú sekvenciu a stále
// bráni zjavnému zneužitiu poľa na dlhý text.
const updateEmojiBody = z.object({ emoji: z.string().trim().max(32).nullable() });
const doneBody = z.object({ done: z.boolean() });
const idParam = z.object({ id: z.string().uuid() });

export function registerDailyTasksRoutes(app: Hono<AppBindings>, db: Database): void {
  app.get("/api/daily-tasks", requireUser(db), async (c) => {
    const user = c.get("user");
    const rows = await listDailyTasks(db, user.userId);
    return c.json({ rows });
  });

  // issue 473: odznak počtu v ľavom menu — počet MOJICH otvorených (bez fajky)
  // úloh. Literal-path súrodenec MUSÍ byť pred `/:id` trasami rovnakej metódy
  // (`.claude/rules/http-routes.md` — poradie literal-vs-`:param`); dnes žiadna
  // GET `/:id` trasa neexistuje, ale poradie sa drží ako zvyk (rovnako ako
  // `upozornenia-routes.ts`'s `/count`).
  app.get("/api/daily-tasks/count", requireUser(db), async (c) => {
    const user = c.get("user");
    const count = await countOpenDailyTasks(db, user.userId);
    return c.json({ count });
  });

  app.post("/api/daily-tasks", requireSameOrigin(), requireUser(db), zValidator("json", createBody), async (c) => {
    const { text } = c.req.valid("json");
    const user = c.get("user");
    const created = await createDailyTask(db, { userId: user.userId, text, now: new Date() });
    return c.json({ ok: true as const, id: created.id });
  });

  app.patch("/api/daily-tasks/:id/text", requireSameOrigin(), requireUser(db), zValidator("param", idParam), zValidator("json", updateTextBody), async (c) => {
    const { id } = c.req.valid("param");
    const { text } = c.req.valid("json");
    const user = c.get("user");
    const updated = await updateDailyTaskText(db, { id, userId: user.userId, text, now: new Date() });
    return c.json({ ok: true as const, updated });
  });

  app.patch("/api/daily-tasks/:id/emoji", requireSameOrigin(), requireUser(db), zValidator("param", idParam), zValidator("json", updateEmojiBody), async (c) => {
    const { id } = c.req.valid("param");
    const { emoji } = c.req.valid("json");
    const user = c.get("user");
    const updated = await updateDailyTaskEmoji(db, { id, userId: user.userId, emoji: emoji === "" ? null : emoji, now: new Date() });
    return c.json({ ok: true as const, updated });
  });

  app.post("/api/daily-tasks/:id/done", requireSameOrigin(), requireUser(db), zValidator("param", idParam), zValidator("json", doneBody), async (c) => {
    const { id } = c.req.valid("param");
    const { done } = c.req.valid("json");
    const user = c.get("user");
    const updated = await setDailyTaskDone(db, { id, userId: user.userId, done, now: new Date() });
    return c.json({ ok: true as const, updated });
  });

  app.delete("/api/daily-tasks/:id", requireSameOrigin(), requireUser(db), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("user");
    const removed = await deleteDailyTask(db, { id, userId: user.userId });
    return c.json({ ok: true as const, removed });
  });
}
