import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { listMailLog, summarizeMailLog, type MailLogFilter } from "../modules/mail-log/queries.js";
import { requireUser, type AppBindings } from "./middleware.js";

// Obdobie je ZOZNAM povolených hodnôt, nie ľubovoľný dátum — obrazovka
// ponúka presne tieto štyri a nič iné (jednoduchšie než plný rozsah dátumov,
// MVP), takže sa nedá poslať dopyt cez celú históriu omylom.
const PERIOD_DAYS: Readonly<Record<string, number | null>> = { "7": 7, "30": 30, "90": 90, all: null };

const listQuery = z.object({
  source: z.enum(["nedostupne", "posta_uncollected", "order_reminder", "supplier_order", "order_merge"]).optional(),
  status: z.enum(["sent", "failed", "skipped"]).optional(),
  period: z.enum(["7", "30", "90", "all"]).default("30"),
});

export function registerMailLogRoutes(app: Hono<AppBindings>, db: Database, adminBaseUrl: string): void {
  // Čítanie — každý prihlásený zamestnanec, rovnaká úroveň ako ostatné
  // obrazovky s objednávkami (tie tiež zobrazujú e-mail zákazníka).
  app.get("/api/mail-log", requireUser(db), zValidator("query", listQuery), async (c) => {
    const { source, status, period } = c.req.valid("query");
    const days = PERIOD_DAYS[period] ?? null;
    const filter: MailLogFilter = {
      limit: 200,
      ...(source === undefined ? {} : { source }),
      ...(status === undefined ? {} : { status }),
      ...(days === null ? {} : { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }),
    };
    // Súhrn ZÁMERNE ignoruje filter stavu (`summarizeMailLog` ho zahadzuje) —
    // inak by "odoslané: 12, zlyhané: 0" pri zapnutom filtri "len odoslané"
    // tvrdilo, že nič nezlyhalo, hoci len nie je vidno.
    const [rows, summary] = await Promise.all([listMailLog(db, filter, adminBaseUrl), summarizeMailLog(db, filter)]);
    return c.json({ rows, summary, period });
  });
}
