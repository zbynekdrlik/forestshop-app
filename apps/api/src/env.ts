import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  SESSION_COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Obsahuje prihlasovací `hash` — patrí LEN do .env na dev2 a do GitHub Secrets.
  // Nepovinná: bez nej appka beží, len ručný import vráti 503.
  SHOPTET_EXPORT_URL: z.string().url().optional(),
  CATALOG_RAW_DIR: z.string().min(1).default("./data/catalog-raw"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Chybná konfigurácia prostredia: ${parsed.error.message}`);
  }
  return parsed.data;
}
