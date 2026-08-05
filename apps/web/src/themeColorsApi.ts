import { z } from "zod";

// issue 264: obrazovka "Farby aplikácie" (koliesko v Topbar) — zrkadlí
// `http/theme-color-routes.ts`.

const themeColorSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  defaultValue: z.string(),
  isCustomized: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedByName: z.string().nullable(),
});
export type ThemeColor = z.infer<typeof themeColorSchema>;

const listSchema = z.object({ colors: z.array(themeColorSchema) });

const writeSchema = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: z.string() })]);
export type ThemeColorWriteResult = z.infer<typeof writeSchema>;

export class ThemeColorsUnauthorizedError extends Error {
  constructor() {
    super("Neprihlásený");
  }
}

async function readJson(response: Response, fallback: string): Promise<unknown> {
  if (response.status === 401) throw new ThemeColorsUnauthorizedError();
  if (!response.ok) {
    try {
      const body: unknown = await response.json();
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (parsed.success) throw new Error(parsed.data.error);
    } catch (error) {
      if (error instanceof Error && error.message !== "") throw error;
    }
    throw new Error(fallback);
  }
  return await response.json();
}

export async function fetchThemeColors(): Promise<readonly ThemeColor[]> {
  const response = await fetch("/api/theme-colors");
  return listSchema.parse(await readJson(response, "Farby aplikácie sa nepodarilo načítať")).colors;
}

export async function saveThemeColors(values: Readonly<Record<string, string>>): Promise<ThemeColorWriteResult> {
  const response = await fetch("/api/theme-colors", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });
  return writeSchema.parse(await readJson(response, "Uloženie farieb zlyhalo"));
}

export async function resetThemeColors(): Promise<ThemeColorWriteResult> {
  const response = await fetch("/api/theme-colors/reset", { method: "POST" });
  return writeSchema.parse(await readJson(response, "Vrátenie predvolených farieb zlyhalo"));
}
