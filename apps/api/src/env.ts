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
  // issue 120: SAMOSTATNÝ XML export objednávok (`patternId=-11`) — jediný
  // zdroj interného Shoptet id (CSV export vyššie ho nenesie vôbec). Rovnaké
  // pravidlo ako `SHOPTET_ORDERS_URL`: `hash` je prihlasovací údaj, nikdy do
  // repa. Nepovinná: bez nej appka beží ďalej presne ako doteraz (odkaz na
  // objednávku len na vyhľadávanie, `modules/orders/queries.ts`), len bez
  // tejto premennej nikdy nezíska interné id na priamy odkaz na detail.
  SHOPTET_ORDERS_XML_URL: z.string().url().optional(),
  ORDERS_RAW_DIR: z.string().min(1).default("./data/orders-raw"),
  // issue 65: základ Shoptet-ovho ADMIN rozhrania (nie exportu) pre priamy
  // odkaz na objednávku z obrazovky "Na objednanie" — na rozdiel od
  // `SHOPTET_EXPORT_URL`/`SHOPTET_ORDERS_URL` vyššie NENESIE prihlasovací
  // `hash`, nie je to tajomstvo (je to len verejná doména obchodu). Má
  // rozumný default (skutočná produkčná hodnota), ale ostáva
  // premennou/konfigurovateľnou — nikdy natvrdo v kóde (`.claude/rules/
  // orders.md`'s zásada "admin base patrí do config/env").
  SHOPTET_ADMIN_BASE_URL: z.string().url().default("https://www.forestshop.sk"),
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
