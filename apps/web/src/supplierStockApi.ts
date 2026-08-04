import { z } from "zod";

// issue 212: "Dodávateľský sklad" — zrkadlí `GET /api/supplier-stock`
// (`apps/api/src/http/supplier-stock-routes.ts`).

const availabilitySchema = z.enum(["available", "unavailable", "unknown"]);
export type SupplierAvailability = z.infer<typeof availabilitySchema>;

const rowSchema = z.object({
  link: z.string(),
  // '' = dostupnosť CELÉHO odkazu (issue 224) — jednoveľkostný produkt,
  // alebo doména bez pravidla na čítanie zoznamu veľkostí.
  sizeLabel: z.string(),
  host: z.string(),
  availability: availabilitySchema,
  availabilityText: z.string(),
  price: z.string().nullable(),
  source: z.enum(["json_ld", "meta", "text", "size_list", "none"]),
  ok: z.boolean(),
  error: z.string().nullable(),
  httpStatus: z.number().nullable(),
  checkedAt: z.string(),
  confirmedAt: z.string().nullable(),
});
export type SupplierStockRow = z.infer<typeof rowSchema>;

const unreadableSampleSchema = z.object({ link: z.string(), sizeLabel: z.string() });
export type UnreadableSample = z.infer<typeof unreadableSampleSchema>;

const unreadableSchema = z.object({
  host: z.string(),
  count: z.number(),
  samples: z.array(unreadableSampleSchema),
});
export type UnreadableHost = z.infer<typeof unreadableSchema>;

const runResultSchema = z.object({
  total: z.number(),
  skipped: z.number(),
  checked: z.number(),
  available: z.number(),
  unavailable: z.number(),
  unknown: z.number(),
  failed: z.number(),
  hosts: z.array(z.string()),
});
export type SupplierStockRunResult = z.infer<typeof runResultSchema>;

const statusSchema = z.object({
  overview: z.object({
    total: z.number(),
    available: z.number(),
    unavailable: z.number(),
    unknown: z.number(),
    failed: z.number(),
    lastCheckedAt: z.string().nullable(),
  }),
  rows: z.array(rowSchema),
  unreadable: z.array(unreadableSchema),
  lastRun: z
    .object({
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      status: z.enum(["running", "success", "failure"]),
      errorMessage: z.string().nullable(),
      result: runResultSchema.nullable(),
    })
    .nullable(),
});
export type SupplierStockStatus = z.infer<typeof statusSchema>;

const runNowResultSchema = z.union([
  z.object({ ok: z.literal(true), result: runResultSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export class SupplierStockUnauthorizedError extends Error {
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
  if (response.status === 401) throw new SupplierStockUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchSupplierStockStatus(): Promise<SupplierStockStatus> {
  const response = await fetch("/api/supplier-stock");
  return statusSchema.parse(await readJson(response, "Dodávateľský sklad sa nepodarilo načítať"));
}

export async function runSupplierStockNow(): Promise<SupplierStockRunResult> {
  const response = await fetch("/api/supplier-stock/run-now", { method: "POST" });
  const parsed = runNowResultSchema.parse(await readJson(response, "Beh sa nepodarilo spustiť"));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.result;
}
