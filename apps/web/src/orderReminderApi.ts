import { z } from "zod";

// issue 173: "Pripomienky objednávok" — zrkadlí `OrderReminderRunResult`
// (`apps/api/src/modules/order-reminder/run.ts`).

const rowSchema = z.object({
  orderCode: z.string(),
  adminLink: z.string(),
  name: z.string(),
  phone: z.string(),
  email: z.string(),
  itemLabel: z.string(),
  days: z.number(),
});

const resolvedRowSchema = rowSchema.extend({
  resolvedAt: z.string(),
  resolvedBy: z.enum(["ai", "manual"]),
});

const pendingRowSchema = rowSchema.extend({ reason: z.string() });

const runResultSchema = z.object({
  checkedAt: z.string(),
  noNote: z.array(rowSchema),
  noEmail: z.array(rowSchema),
  emailed: z.array(resolvedRowSchema),
  contacted: z.array(resolvedRowSchema),
  pending: z.array(pendingRowSchema),
  aiNotConfigured: z.boolean(),
  bccMissing: z.boolean(),
  mailNotConfigured: z.boolean(),
  stats: z.object({
    candidates: z.number(),
    noNoteCount: z.number(),
    noEmailCount: z.number(),
    emailedNow: z.number(),
    contactedNow: z.number(),
    pendingCount: z.number(),
  }),
});
export type OrderReminderRunResult = z.infer<typeof runResultSchema>;
export type OrderReminderRow = z.infer<typeof rowSchema>;
export type OrderReminderResolvedRow = z.infer<typeof resolvedRowSchema>;
export type OrderReminderPendingRow = z.infer<typeof pendingRowSchema>;

const statusSchema = z.object({
  enabled: z.boolean(),
  lastRun: z
    .object({
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      status: z.enum(["running", "success", "failure"]),
      errorMessage: z.string().nullable(),
      result: runResultSchema.nullable(),
      skippedReason: z.union([z.string(), z.null()]),
    })
    .nullable(),
});
export type OrderReminderStatus = z.infer<typeof statusSchema>;

const setEnabledResultSchema = z.object({ ok: z.literal(true), enabled: z.boolean() });

const runNowResultSchema = z.union([
  z.object({ ok: z.literal(true), result: runResultSchema }),
  z.object({ error: z.string() }),
]);

const overrideResultSchema = z.union([
  z.object({ ok: z.literal(true), resolution: z.enum(["contacted", "emailed"]) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type OrderReminderOverrideResult = z.infer<typeof overrideResultSchema>;

const previewResultSchema = z.union([
  z.object({ ok: z.literal(true), subject: z.string(), html: z.string(), recipient: z.string(), name: z.string(), orderCode: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type OrderReminderPreview = Extract<z.infer<typeof previewResultSchema>, { readonly ok: true }>;

export class OrderReminderUnauthorizedError extends Error {
  constructor() {
    super("Neprihlásený");
  }
}

const errorBodySchema = z.object({ error: z.string() });

async function serverErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    if (parsed.success) return parsed.data.error;
  } catch {
    // telo nie je platný JSON — použi všeobecnú hlášku
  }
  return fallback;
}

async function readJson(response: Response, fallback: string): Promise<unknown> {
  if (response.status === 401) throw new OrderReminderUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchOrderReminderStatus(): Promise<OrderReminderStatus> {
  const response = await fetch("/api/order-reminder");
  return statusSchema.parse(await readJson(response, "Pripomienky objednávok sa nepodarilo načítať"));
}

export async function setOrderReminderEnabled(enabled: boolean): Promise<boolean> {
  const response = await fetch("/api/order-reminder/enabled", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const parsed = setEnabledResultSchema.parse(await readJson(response, "Zmena sa nepodarila"));
  return parsed.enabled;
}

export async function runOrderReminderNow(): Promise<OrderReminderRunResult> {
  const response = await fetch("/api/order-reminder/run-now", { method: "POST" });
  const parsed = runNowResultSchema.parse(await readJson(response, "Beh sa nepodarilo spustiť"));
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.result;
}

export async function overrideOrderReminder(orderCode: string, action: "contact" | "send"): Promise<OrderReminderOverrideResult> {
  const response = await fetch("/api/order-reminder/override", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderCode, action }),
  });
  if (response.status === 401) throw new OrderReminderUnauthorizedError();
  return overrideResultSchema.parse(await response.json());
}

export async function fetchOrderReminderPreview(orderCode: string): Promise<OrderReminderPreview> {
  const response = await fetch(`/api/order-reminder/preview/${encodeURIComponent(orderCode)}`);
  const parsed = previewResultSchema.parse(await readJson(response, "Náhľad sa nepodarilo načítať"));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed;
}
