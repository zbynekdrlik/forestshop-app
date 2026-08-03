import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { record } from "../modules/audit/service.js";
import {
  allowedPlaceholderNames,
  isMailTemplateKey,
  MAIL_TEMPLATE_KINDS,
  placeholdersFor,
  type MailTemplateKey,
} from "../modules/mail-templates/registry.js";
import { renderTemplate, validateTemplateText } from "../modules/mail-templates/render.js";
import { previewContext } from "../modules/mail-templates/samples.js";
import { listTemplateHistory, listTemplates, resetTemplate, saveTemplate } from "../modules/mail-templates/store.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

// issue 192: obrazovka "Texty e-mailov". Očakávané doménové zlyhania (neznámy
// druh e-mailu, neplatná šablóna) vracajú 200 s `{ok:false, error}` — nikdy
// 4xx, lebo Chromium loguje konzolovú chybu pri KAŽDEJ ne-2xx odpovedi a e2e
// balík má nulovú toleranciu (`.claude/rules/testing.md`).

const keyParam = z.object({ key: z.string().min(1) });
const draftBody = z.object({ subject: z.string().max(500), body: z.string().max(20_000) });
const previewBody = draftBody.extend({ key: z.string().min(1) });

function kindSummary(key: MailTemplateKey): {
  readonly key: MailTemplateKey;
  readonly label: string;
  readonly description: string;
  readonly defaultSubject: string;
  readonly defaultBody: string;
  readonly placeholders: readonly { readonly name: string; readonly label: string }[];
} {
  const kind = MAIL_TEMPLATE_KINDS[key];
  return {
    key,
    label: kind.label,
    description: kind.description,
    defaultSubject: kind.defaultText.subject,
    defaultBody: kind.defaultText.body,
    placeholders: placeholdersFor(key).map((p) => ({ name: p.name, label: p.label })),
  };
}

export function registerMailTemplateRoutes(app: Hono<AppBindings>, db: Database): void {
  // Čítanie — každý prihlásený zamestnanec (rovnaká úroveň ako ostatné
  // obrazovky); upravovať smie až admin/manažér nižšie.
  app.get("/api/mail-templates", requireUser(db), async (c) => {
    const resolved = await listTemplates(db);
    return c.json({
      templates: resolved.map((t) => ({
        ...kindSummary(t.key),
        subject: t.subject,
        body: t.body,
        isCustomized: t.isCustomized,
        updatedAt: t.updatedAt?.toISOString() ?? null,
        updatedByName: t.updatedByName,
      })),
    });
  });

  // Náhľad rozpísaného (ešte NEULOŽENÉHO) znenia na skutočných dátach.
  // Literálna cesta MUSÍ byť registrovaná pred `/:key` súrodencami nižšie
  // (`.claude/rules/http-routes.md`).
  app.post("/api/mail-templates/preview", requireSameOrigin(), requireUser(db), zValidator("json", previewBody), async (c) => {
    const { key, subject, body } = c.req.valid("json");
    if (!isMailTemplateKey(key)) return c.json({ ok: false as const, error: "Neznámy druh e-mailu." });
    const errors = validateTemplateText({ subject, body }, allowedPlaceholderNames(key));
    if (errors.length > 0) return c.json({ ok: false as const, error: errors.join(" ") });
    const rendered = renderTemplate({ subject, body }, await previewContext(db, key));
    return c.json({ ok: true as const, subject: rendered.subject, html: rendered.html, text: rendered.text });
  });

  app.get("/api/mail-templates/:key/history", requireUser(db), zValidator("param", keyParam), async (c) => {
    const { key } = c.req.valid("param");
    if (!isMailTemplateKey(key)) return c.json({ ok: false as const, error: "Neznámy druh e-mailu." });
    const entries = await listTemplateHistory(db, key);
    return c.json({
      ok: true as const,
      entries: entries.map((e) => ({
        id: e.id,
        action: e.action,
        subject: e.subject,
        changedAt: e.changedAt.toISOString(),
        changedByName: e.changedByName,
      })),
    });
  });

  app.put("/api/mail-templates/:key", requireSameOrigin(), requireUser(db), requireRole("admin", "manazer"), zValidator("param", keyParam), zValidator("json", draftBody), async (c) => {
    const { key } = c.req.valid("param");
    if (!isMailTemplateKey(key)) return c.json({ ok: false as const, error: "Neznámy druh e-mailu." });
    const { subject, body } = c.req.valid("json");
    const user = c.get("user");
    const now = new Date();
    const result = await saveTemplate(db, { key, subject, body, userId: user.userId, now });
    if (!result.ok) return c.json({ ok: false as const, error: result.errors.join(" ") });
    await record(db, { at: now, actorUserId: user.userId, action: "mail_template.save", entity: "mail_template", entityId: key, data: { key } });
    return c.json({ ok: true as const });
  });

  app.post("/api/mail-templates/:key/reset", requireSameOrigin(), requireUser(db), requireRole("admin", "manazer"), zValidator("param", keyParam), async (c) => {
    const { key } = c.req.valid("param");
    if (!isMailTemplateKey(key)) return c.json({ ok: false as const, error: "Neznámy druh e-mailu." });
    const user = c.get("user");
    const now = new Date();
    await resetTemplate(db, { key, userId: user.userId, now });
    await record(db, { at: now, actorUserId: user.userId, action: "mail_template.reset", entity: "mail_template", entityId: key, data: { key } });
    return c.json({ ok: true as const });
  });
}
