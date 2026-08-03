import { z } from "zod";

// issue 193: obrazovka "Odoslané e-maily" — zrkadlí `http/mail-log-routes.ts`.
// Len čítanie, žiadny zápis (do knihy zapisujú samy odosielacie cesty).

export const MAIL_LOG_SOURCES = ["nedostupne", "posta_uncollected", "order_reminder", "supplier_order"] as const;
export type MailLogSource = (typeof MAIL_LOG_SOURCES)[number];

// Popisky sú TU (nie na serveri) z rovnakého dôvodu ako pri stavoch riadkov
// objednávky — server posiela kľúč, jeho slovenské meno patrí obrazovke.
export const MAIL_LOG_SOURCE_LABELS: Readonly<Record<MailLogSource, string>> = {
  nedostupne: "Nedostupné tovary",
  posta_uncollected: "Nevyzdvihnuté zásielky",
  order_reminder: "Pripomienky objednávok",
  supplier_order: "Objednávka dodávateľovi",
};

const rowSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  source: z.enum(MAIL_LOG_SOURCES),
  status: z.enum(["sent", "failed", "skipped"]),
  trigger: z.enum(["scheduled", "manual"]),
  templateKey: z.string().nullable(),
  recipient: z.string(),
  subject: z.string().nullable(),
  orderCode: z.string().nullable(),
  variantCode: z.string().nullable(),
  packageNumber: z.string().nullable(),
  sequence: z.number().nullable(),
  reason: z.string().nullable(),
  actorName: z.string().nullable(),
  adminLink: z.string().nullable(),
});
export type MailLogRow = z.infer<typeof rowSchema>;

const summarySchema = z.object({
  sent: z.number(),
  failed: z.number(),
  skipped: z.number(),
  duplicatesBlocked: z.number(),
});
export type MailLogSummary = z.infer<typeof summarySchema>;

const listSchema = z.object({ rows: z.array(rowSchema), summary: summarySchema, period: z.string() });
export type MailLogList = z.infer<typeof listSchema>;

export type MailLogPeriod = "7" | "30" | "90" | "all";

export class MailLogUnauthorizedError extends Error {
  constructor() {
    super("Neprihlásený");
  }
}

export interface MailLogFilter {
  readonly source?: MailLogSource | "";
  readonly status?: "sent" | "failed" | "skipped" | "";
  readonly period: MailLogPeriod;
}

export async function fetchMailLog(filter: MailLogFilter): Promise<MailLogList> {
  const params = new URLSearchParams({ period: filter.period });
  if (filter.source !== undefined && filter.source !== "") params.set("source", filter.source);
  if (filter.status !== undefined && filter.status !== "") params.set("status", filter.status);
  const response = await fetch(`/api/mail-log?${params.toString()}`);
  if (response.status === 401) throw new MailLogUnauthorizedError();
  if (!response.ok) throw new Error("Prehľad odoslaných e-mailov sa nepodarilo načítať");
  return listSchema.parse(await response.json());
}
