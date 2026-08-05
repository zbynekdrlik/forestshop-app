import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { record } from "../modules/audit/service.js";
import { listThemeColors, resetThemeColors, saveThemeColors } from "../modules/theme-colors/store.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

// issue 264: obrazovka "Farby aplikácie" (koliesko vpravo hore v Topbar).
// Neplatný kód farby vracia 200 s `{ok:false, error}`, NIKDY 4xx — rovnaký
// dôvod ako `mail-template-routes.ts` (Chromium loguje konzolovú chybu pre
// KAŽDÚ ne-2xx odpoveď, `.claude/rules/testing.md`).

// Zámerne voľná (nie hex-validovaná priamo tu) — presná hex kontrola beží v
// `registry.ts`'s `validateThemeColorValues` a vracia doménovú chybu v tele
// (200 {ok:false}), nie zValidator-ovú 400.
const saveBody = z.object({ values: z.record(z.string(), z.string()) });

export function registerThemeColorRoutes(app: Hono<AppBindings>, db: Database): void {
  // Čítanie — každý prihlásený zamestnanec (rovnaká úroveň ako iné obrazovky):
  // farby čipov vidí každý, kto vidí "Na objednanie", nielen kto ich smie meniť.
  app.get("/api/theme-colors", requireUser(db), async (c) => {
    const colors = await listThemeColors(db);
    return c.json({
      colors: colors.map((col) => ({
        key: col.key,
        label: col.label,
        value: col.value,
        defaultValue: col.defaultValue,
        isCustomized: col.isCustomized,
        updatedAt: col.updatedAt?.toISOString() ?? null,
        updatedByName: col.updatedByName,
      })),
    });
  });

  app.put(
    "/api/theme-colors",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", saveBody),
    async (c) => {
      const { values } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      const result = await saveThemeColors(db, { values, userId: user.userId, now });
      if (!result.ok) return c.json({ ok: false as const, error: result.errors.join(" ") });
      await record(db, { at: now, actorUserId: user.userId, action: "theme_colors.save", entity: "theme_colors", data: { keys: Object.keys(values) } });
      return c.json({ ok: true as const });
    },
  );

  app.post("/api/theme-colors/reset", requireSameOrigin(), requireUser(db), requireRole("admin", "manazer"), async (c) => {
    const user = c.get("user");
    const now = new Date();
    await resetThemeColors(db);
    await record(db, { at: now, actorUserId: user.userId, action: "theme_colors.reset", entity: "theme_colors" });
    return c.json({ ok: true as const });
  });
}
