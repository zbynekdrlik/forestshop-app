import { z } from "zod";

// issue 213: "Vypredané → Skladom" — zrkadlí `GET /api/restock`
// (`apps/api/src/http/restock-routes.ts`).

const eventSchema = z.object({
  id: z.string(),
  at: z.string(),
  variantCode: z.string(),
  pairCode: z.string().nullable(),
  productName: z.string(),
  supplier: z.string().nullable(),
  supplierLink: z.string(),
  supplierAvailabilityText: z.string(),
  supplierPrice: z.string().nullable(),
  confirmedAt: z.string(),
  // Priama adresa detailu z feedu (issue 329). `null` = kód vo feede nie je
  // — odkaz sa v tomto zozname nezobrazí vôbec (žiadny fallback na
  // vyhľadávanie, na rozdiel od "Pripravené na prepnutie" nižšie).
  ourUrl: z.string().nullable(),
});
export type RestockEvent = z.infer<typeof eventSchema>;

const runResultSchema = z.union([
  z.object({ status: z.literal("nothing_to_do"), overLimit: z.number() }),
  z.object({
    status: z.literal("ok"),
    switched: z.number(),
    overLimit: z.number(),
    codes: z.array(z.string()),
  }),
  z.object({
    status: z.literal("failed"),
    attempted: z.number(),
    overLimit: z.number(),
    errorDetail: z.string(),
  }),
]);
export type RestockRunResult = z.infer<typeof runResultSchema>;

// issue 226: krížová kontrola nášho stavu proti Shoptetovmu feedu.
const feedConflictRowSchema = z.object({
  variantCode: z.string(),
  productName: z.string(),
  ourState: z.enum(["sellable", "out_of_stock", "discontinued"]),
  feedAvailability: z.string(),
  ourUrl: z.string(),
});
const feedConflictsSchema = z.object({
  total: z.number(),
  rows: z.array(feedConflictRowSchema),
});
export type FeedConflictRow = z.infer<typeof feedConflictRowSchema>;

const statusSchema = z.object({
  enabled: z.boolean(),
  maxPerRun: z.number(),
  waiting: z.object({ now: z.number(), overLimit: z.number() }),
  feedConflicts: feedConflictsSchema,
  events: z.array(eventSchema),
  lastRun: z
    .object({
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      status: z.enum(["running", "success", "failure"]),
      errorMessage: z.string().nullable(),
      result: runResultSchema.nullable(),
      skippedReason: z.string().nullable(),
    })
    .nullable(),
});
export type RestockStatus = z.infer<typeof statusSchema>;

const setEnabledResultSchema = z.object({ ok: z.literal(true), enabled: z.boolean() });
// issue 413: run-now beží odteraz ASYNC — 202 `{ok:true, started:true}`
// namiesto pôvodného synchrónneho `{ok:true, result}`, "beh už prebieha"
// je 200 `{ok:false, error}` (`.claude/rules/testing.md`).
const runNowResultSchema = z.union([
  z.object({ ok: z.literal(true), started: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export class RestockUnauthorizedError extends Error {
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
  if (response.status === 401) throw new RestockUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchRestockStatus(): Promise<RestockStatus> {
  const response = await fetch("/api/restock");
  return statusSchema.parse(await readJson(response, "Prepínanie sa nepodarilo načítať"));
}

const waitingSchema = z.object({
  total: z.number(),
  rows: z.array(
    z.object({
      variantCode: z.string(),
      pairCode: z.string().nullable(),
      productName: z.string(),
      supplier: z.string().nullable(),
      supplierLink: z.string(),
      supplierAvailabilityText: z.string(),
      supplierPrice: z.string().nullable(),
      confirmedAt: z.string(),
      // Priama adresa detailu z feedu (issue 220). `null` = kód vo feede nie
      // je; odkaz vtedy padne späť na vyhľadávanie podľa kódu.
      ourUrl: z.string().nullable(),
      // issue 527: vypredaný, alebo predobjednávkový kandidát — badge v UI.
      reason: z.enum(["out_of_stock", "preorder"]),
    }),
  ),
  suppliers: z.array(z.object({ name: z.string(), count: z.number() })),
});
export type RestockWaitingPage = z.infer<typeof waitingSchema>;
export type RestockWaitingRow = RestockWaitingPage["rows"][number];

export async function fetchRestockWaiting(options: {
  readonly limit: number;
  readonly offset: number;
  readonly supplier: string;
}): Promise<RestockWaitingPage> {
  const params = new URLSearchParams({
    limit: String(options.limit),
    offset: String(options.offset),
  });
  if (options.supplier !== "") params.set("supplier", options.supplier);
  const response = await fetch(`/api/restock/waiting?${params.toString()}`);
  return waitingSchema.parse(await readJson(response, "Zoznam sa nepodarilo načítať"));
}

export async function setRestockEnabled(enabled: boolean): Promise<boolean> {
  const response = await fetch("/api/restock/enabled", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const parsed = setEnabledResultSchema.parse(await readJson(response, "Zmena sa nepodarila"));
  return parsed.enabled;
}

export async function runRestockNow(): Promise<void> {
  const response = await fetch("/api/restock/run-now", { method: "POST" });
  const parsed = runNowResultSchema.parse(await readJson(response, "Beh sa nepodarilo spustiť"));
  if (!parsed.ok) throw new Error(parsed.error);
}
