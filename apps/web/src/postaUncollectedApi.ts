import { z } from "zod";

// issue 172: "Nevyzdvihnuté zásielky" — zrkadlí `PostaUncollectedRunResult`
// (`apps/api/src/modules/posta-uncollected/run.ts`).

const shipmentSchema = z.object({
  orderCode: z.string(),
  packageNumber: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  officeName: z.string(),
  officeAddr: z.string(),
  retainedTill: z.string(),
  notifiedSince: z.string(),
  daysAtPost: z.number(),
  count: z.number(),
  lastSentAt: z.string(),
  callNeeded: z.boolean(),
  trackingLink: z.string(),
  adminLink: z.string(),
});
export type PostaUncollectedShipment = z.infer<typeof shipmentSchema>;

const invalidSchema = z.object({
  orderCode: z.string(),
  packageNumber: z.string(),
  name: z.string(),
  adminLink: z.string(),
});

const errorRowSchema = z.object({ orderCode: z.string(), packageNumber: z.string(), message: z.string() });

const coverageSchema = z.object({
  eligibleOrders: z.number(),
  dispatchedOrders: z.number(),
  dispatchedWithPackage: z.number(),
  dispatchedWithoutPackage: z.number(),
  missingPackage: z.number(),
  daysSinceLastPackage: z.number().nullable(),
  dispatchedStatusUnknown: z.boolean(),
  degraded: z.boolean(),
});

const runResultSchema = z.object({
  checkedAt: z.string(),
  uncollected: z.array(shipmentSchema),
  invalid: z.array(invalidSchema),
  errors: z.array(errorRowSchema),
  coverage: coverageSchema,
  bccMissing: z.boolean(),
  mailNotConfigured: z.boolean(),
  stats: z.object({
    checked: z.number(),
    uncollectedCount: z.number(),
    invalidCount: z.number(),
    errorCount: z.number(),
    apiSkipped: z.number(),
    emailsSent: z.number(),
    emailsBlocked: z.number(),
  }),
});
export type PostaUncollectedRunResult = z.infer<typeof runResultSchema>;

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
export type PostaUncollectedStatus = z.infer<typeof statusSchema>;

const setEnabledResultSchema = z.object({ ok: z.literal(true), enabled: z.boolean() });

// issue 413: run-now beží odteraz ASYNC — server vráti 202 `{ok:true,
// started:true}` HNEĎ (beh pokračuje na pozadí) namiesto pôvodného
// synchrónneho `{ok:true, result}`. "Beh už prebieha" (druhý klik/
// Cloudflare retry) je BEŽNÝ doménový výsledok, server ho vracia s 200
// `{error: "..."}` (`.claude/rules/testing.md`), nikdy 4xx/5xx — ten istý
// tvar, aký táto schéma už mala pre skutočné zlyhania.
const runNowResultSchema = z.union([
  z.object({ ok: z.literal(true), started: z.literal(true) }),
  z.object({ error: z.string() }),
]);

const previewResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    subject: z.string(),
    html: z.string(),
    recipient: z.string(),
    name: z.string(),
    packageNumber: z.string(),
    orderCode: z.string(),
    count: z.number(),
    alreadySent: z.number(),
    maxReached: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type PostaUncollectedPreview = Extract<z.infer<typeof previewResultSchema>, { readonly ok: true }>;

export class PostaUncollectedUnauthorizedError extends Error {
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
  if (response.status === 401) throw new PostaUncollectedUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchPostaUncollectedStatus(): Promise<PostaUncollectedStatus> {
  const response = await fetch("/api/posta-uncollected");
  return statusSchema.parse(await readJson(response, "Nevyzdvihnuté zásielky sa nepodarilo načítať"));
}

export async function setPostaUncollectedEnabled(enabled: boolean): Promise<boolean> {
  const response = await fetch("/api/posta-uncollected/enabled", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const parsed = setEnabledResultSchema.parse(await readJson(response, "Zmena sa nepodarila"));
  return parsed.enabled;
}

export async function runPostaUncollectedNow(): Promise<void> {
  const response = await fetch("/api/posta-uncollected/run-now", { method: "POST" });
  const parsed = runNowResultSchema.parse(await readJson(response, "Beh sa nepodarilo spustiť"));
  if ("error" in parsed) throw new Error(parsed.error);
}

export async function fetchPostaUncollectedPreview(packageNumber: string): Promise<PostaUncollectedPreview> {
  const response = await fetch(`/api/posta-uncollected/preview/${encodeURIComponent(packageNumber)}`);
  const parsed = previewResultSchema.parse(await readJson(response, "Náhľad sa nepodarilo načítať"));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed;
}
