// issue 309: "Eshop → Upozornenia" — najbližšia udalosť z majiteľovho Google
// kalendára. Vlastný registrátor trasy (nie súčasť `upozornenia-routes.ts`)
// — modul za ňou (`modules/calendar/`) nie je DB-backed "upozornenie", je to
// nezávislý read-through pohľad na externý kalendár (rovnaký princíp ako
// `dpd-routes.ts`/`shop-feed`'s vlastné trasy vedľa `upozornenia`).

import type { Hono } from "hono";
import type { Database } from "../db/client.js";
import type { NextEventService } from "../modules/calendar/service.js";
import { requireUser, type AppBindings } from "./middleware.js";

// `deps === undefined` = `GOOGLE_CALENDAR_ICS_URL` nie je nastavená
// (`env.ts`) — appka beží ďalej, karta na nástenke sa jednoducho nezobrazí
// (rovnaký "configured" vzor ako `dpd-routes.ts`'s `DpdRunDeps`).
export function registerCalendarRoutes(app: Hono<AppBindings>, db: Database, deps?: NextEventService): void {
  app.get("/api/upozornenia/next-event", requireUser(db), async (c) => {
    if (deps === undefined) return c.json({ configured: false as const, events: [], error: false });
    const result = await deps.getNextEvent(new Date());
    return c.json({ configured: true as const, events: result.ok ? result.events : [], error: !result.ok });
  });
}
