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
  // Rovnaké pravidlo ako SHOPTET_EXPORT_URL vyššie — `hash` v query parametri
  // je prihlasovací údaj, nikdy sa nezapisuje do repa. Nepovinná (#21): bez
  // nej appka beží ďalej, len CLI import objednávok zlyhá nahlas hneď na štarte.
  SHOPTET_ORDERS_URL: z.string().url().optional(),
  ORDERS_RAW_DIR: z.string().min(1).default("./data/orders-raw"),
  // Odosielanie objednávky dodávateľovi mailom (#31) — rovnaký mechanizmus ako
  // stará appka (SMTP, env premenné). Nepovinné ako `SHOPTET_EXPORT_URL`
  // vyššie: bez `MAIL_HOST` appka beží ďalej, len odoslanie mailom vráti 503
  // (heslo/prihlasovacie údaje sú tiež nepovinné — niektoré SMTP relaye
  // nevyžadujú autentifikáciu).
  MAIL_HOST: z.string().min(1).optional(),
  MAIL_PORT: z.coerce.number().int().positive().default(587),
  MAIL_USER: z.string().optional(),
  MAIL_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Chybná konfigurácia prostredia: ${parsed.error.message}`);
  }
  return parsed.data;
}
