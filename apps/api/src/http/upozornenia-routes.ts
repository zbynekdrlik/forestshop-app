import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { record } from "../modules/audit/service.js";
import { countActionableUpozornenia, listResolvedUpozornenia, listUpozornenia, type UpozornenieTypeValue } from "../modules/upozornenia/queries.js";
import {
  cancelPostpone,
  createOwnNote,
  deleteUpozornenie,
  markAllSeen,
  postponeUpozornenie,
  resolveUpozornenie,
  returnUpozornenieToOpen,
  updateOwnNote,
} from "../modules/upozornenia/service.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

// issue 267/268/269: `.claude/rules/testing.md`'s "Nová pgEnum hodnota" past
// platí aj tu, preto validácia typu ide cez `z.enum` s POLOM hodnôt, nie
// natvrdo jedným literálom, aby budúci ďalší automatický zdroj pridal svoju
// hodnotu LEN sem + do enumu, nikde inde.
const KNOWN_TYPES: readonly [UpozornenieTypeValue, ...UpozornenieTypeValue[]] = ["vlastna_poznamka", "nevyzdvihnuta_zasielka", "vratenie"];

const listQuery = z.object({
  type: z.enum(KNOWN_TYPES).optional(),
  includeResolved: z.enum(["true", "false"]).optional(),
  // issue 267 (živé overenie, gap 2): nezávislá os od `includeResolved` —
  // jediný spôsob, ako odkryť odloženú kartu (`queries.ts`'s
  // `notPostponedCondition`).
  includePostponed: z.enum(["true", "false"]).optional(),
});

const createBody = z.object({
  title: z.string().trim().min(1).max(200),
  details: z.string().trim().max(2000).optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

const updateBody = createBody;

const idParam = z.object({ id: z.string().uuid() });

const postponeBody = z.object({ until: z.coerce.date() });

export function registerUpozorneniaRoutes(app: Hono<AppBindings>, db: Database): void {
  // Čítanie — každý prihlásený zamestnanec (rovnaká úroveň ako
  // #172/#173/#176 — `.claude/rules/nedostupne.md`).
  app.get("/api/upozornenia", requireUser(db), zValidator("query", listQuery), async (c) => {
    const { type, includeResolved, includePostponed } = c.req.valid("query");
    const rows = await listUpozornenia(
      db,
      { ...(type === undefined ? {} : { type }), includeResolved: includeResolved === "true", includePostponed: includePostponed === "true" },
      new Date(),
    );
    return c.json({ rows });
  });

  // Literal-path súrodenec MUSÍ byť pred akoukoľvek budúcou `/api/upozornenia/:id`
  // trasou rovnakej metódy (`.claude/rules/http-routes.md`) — dnes žiadna GET
  // `:id` trasa neexistuje, ale poradie sa drží ako zvyk, nie náhodou.
  app.get("/api/upozornenia/count", requireUser(db), async (c) => {
    const count = await countActionableUpozornenia(db, new Date());
    return c.json({ count });
  });

  // issue 283: záložka "Vybavené" — história vybavených kariet, rovnaká
  // čítacia úroveň oprávnenia ako hlavný zoznam vyššie. Literal-path
  // súrodenec pred akoukoľvek budúcou `/api/upozornenia/:id` GET trasou
  // (`.claude/rules/http-routes.md`).
  app.get("/api/upozornenia/resolved", requireUser(db), async (c) => {
    const rows = await listResolvedUpozornenia(db, new Date());
    return c.json({ rows });
  });

  // Vytvorenie vlastnej poznámky — rovnaká rola ako zvyšok appky pre zápis.
  app.post("/api/upozornenia", requireSameOrigin(), requireUser(db), requireRole("admin", "manazer"), zValidator("json", createBody), async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    const now = new Date();
    const created = await createOwnNote(db, {
      title: body.title,
      details: body.details ?? "",
      dueAt: body.dueAt ?? null,
      createdByUserId: user.userId,
      now,
    });
    await record(db, { at: now, actorUserId: user.userId, action: "upozornenie.created", entity: "upozornenie", entityId: created.id, data: { title: body.title } });
    return c.json({ ok: true as const, id: created.id });
  });

  // Hromadné označenie "videné" — volané pri OTVORENÍ záložky, nie per-karta
  // kliknutím (`.claude/rules/…` návrhový komentár na tickete). Čítacia
  // úroveň oprávnenia — nie je to zápis obsahu ani vyriešenie, len sledovanie
  // toho, čo obsluha už videla.
  app.post("/api/upozornenia/mark-seen", requireSameOrigin(), requireUser(db), async (c) => {
    const count = await markAllSeen(db, new Date());
    return c.json({ ok: true as const, marked: count });
  });

  app.patch(
    "/api/upozornenia/:id",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", idParam),
    zValidator("json", updateBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const user = c.get("user");
      const updated = await updateOwnNote(db, { id, title: body.title, details: body.details ?? "", dueAt: body.dueAt ?? null });
      if (updated) {
        await record(db, { at: new Date(), actorUserId: user.userId, action: "upozornenie.updated", entity: "upozornenie", entityId: id, data: { title: body.title } });
      }
      return c.json({ ok: true as const, updated });
    },
  );

  // Zmazanie — issue 327: rozšírené na VŠETKY zdroje (predtým len vlastné
  // poznámky, issue 267), `deleteUpozornenie` (`service.ts`) to komentuje
  // podrobne. Rovnaká disciplína ako `nedostupne-routes.ts`'s odkazy:
  // neznáme/už zmazané id (dvojklik) je NEŠKODNÉ, vždy 200, nikdy 4xx.
  app.delete("/api/upozornenia/:id", requireSameOrigin(), requireUser(db), requireRole("admin", "manazer"), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("user");
    const removed = await deleteUpozornenie(db, id);
    if (removed) {
      await record(db, { at: new Date(), actorUserId: user.userId, action: "upozornenie.deleted", entity: "upozornenie", entityId: id, data: { id } });
    }
    return c.json({ ok: true as const, removed });
  });

  app.post("/api/upozornenia/:id/resolve", requireSameOrigin(), requireUser(db), requireRole("admin", "manazer"), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("user");
    const now = new Date();
    const resolved = await resolveUpozornenie(db, { id, resolvedByUserId: user.userId, now });
    if (resolved) {
      await record(db, { at: now, actorUserId: user.userId, action: "upozornenie.resolved", entity: "upozornenie", entityId: id, data: { id } });
    }
    return c.json({ ok: true as const, resolved });
  });

  app.post(
    "/api/upozornenia/:id/postpone",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", idParam),
    zValidator("json", postponeBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const { until } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      const postponed = await postponeUpozornenie(db, { id, postponedUntil: until, now });
      if (postponed) {
        await record(db, { at: now, actorUserId: user.userId, action: "upozornenie.postponed", entity: "upozornenie", entityId: id, data: { until: until.toISOString() } });
      }
      return c.json({ ok: true as const, postponed });
    },
  );

  // issue 267 (živé overenie, gap 2): "vrátiť" odloženú kartu SKÔR, než sa
  // vráti sama — rovnaká disciplína ako `/resolve`/`/postpone` (neznáme/už
  // nedoloženo id je 200 {cancelled:false}, nikdy chyba).
  app.post("/api/upozornenia/:id/cancel-postpone", requireSameOrigin(), requireUser(db), requireRole("admin", "manazer"), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("user");
    const now = new Date();
    const cancelled = await cancelPostpone(db, { id });
    if (cancelled) {
      await record(db, { at: now, actorUserId: user.userId, action: "upozornenie.postpone_cancelled", entity: "upozornenie", entityId: id, data: { id } });
    }
    return c.json({ ok: true as const, cancelled });
  });

  // issue 283 (majiteľ, komentár na tickete): vrátenie omylom vybavenej
  // karty späť medzi otvorené, zo záložky "Vybavené". `result` je jedna z
  // troch hodnôt (`returnUpozornenieToOpen`'s vlastný komentár) — 200 vo
  // VŠETKÝCH prípadoch vrátane kolízie (rovnaká disciplína ako `/resolve`/
  // `/cancel-postpone` — bežné, OČAKÁVANÉ zlyhanie nikdy nie je 4xx/5xx,
  // `.claude/rules/testing.md`).
  app.post("/api/upozornenia/:id/return-to-open", requireSameOrigin(), requireUser(db), requireRole("admin", "manazer"), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("user");
    const now = new Date();
    const result = await returnUpozornenieToOpen(db, { id });
    if (result === "returned") {
      await record(db, { at: now, actorUserId: user.userId, action: "upozornenie.returned_to_open", entity: "upozornenie", entityId: id, data: { id } });
    }
    return c.json({ ok: true as const, result });
  });
}
