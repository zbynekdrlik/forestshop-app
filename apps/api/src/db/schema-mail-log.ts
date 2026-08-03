import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema-users.js";

// issue 193, majiteľ: "v automatizaciach dufam su vsetky potrebne statistiky
// komu sa poslal mail a tak dalej". Doteraz si každá automatizácia pamätala
// len TO, ČO POTREBOVALA PRE SEBA (`posta_uncollected_state`'s počítadlo,
// `order_reminder_state`'s výsledok, `nedostupne_state`'s dedup dôkaz) —
// adresa príjemcu, predmet ani dôvod zlyhania sa NIKDE neukladali a posledný
// beh v `job_run.detail` prepíše ten ďalší. Táto tabuľka je JEDNA spoločná
// kniha odoslaných e-mailov pre VŠETKÝCH odosielateľov appky, aby majiteľ
// vedel, čo sa v jeho mene odoslalo.
export const mailLogSource = pgEnum("mail_log_source", [
  "nedostupne",
  "posta_uncollected",
  "order_reminder",
  "supplier_order",
]);

// `skipped` = appka SKUTOČNE chcela poslať a nemohla (chýba adresa, chýba
// nastavenie, dedup to zastavil) — nikdy bežné "ešte nie je čas" (to by
// tabuľku zaplnilo desiatkami nezaujímavých riadkov denne, `mail-log/
// service.ts`).
export const mailLogStatus = pgEnum("mail_log_status", ["sent", "failed", "skipped"]);

// Kto pokus vyvolal — plán, alebo konkrétny zamestnanec. Zámerne SAMOSTATNÝ
// stĺpec od `actor_user_id` (rovnaký dôvod ako `order_reminder_state`'s
// `resolution`/`resolved_by` dvojica): "spustil to plánovač" sa nikdy
// neodvodzuje z toho, že chýba používateľ.
export const mailLogTrigger = pgEnum("mail_log_trigger", ["scheduled", "manual"]);

export const mailLog = pgTable(
  "mail_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    source: mailLogSource("source").notNull(),
    status: mailLogStatus("status").notNull(),
    trigger: mailLogTrigger("trigger").notNull(),
    // Kľúč šablóny z issue 192 (`MAIL_TEMPLATE_KEYS`) — nie FK, aby zmazanie/
    // premenovanie šablóny nikdy nezmazalo históriu odoslanej pošty.
    templateKey: text("template_key"),
    recipient: text("recipient").notNull().default(""),
    bcc: text("bcc"),
    subject: text("subject"),
    orderCode: text("order_code"),
    variantCode: text("variant_code"),
    packageNumber: text("package_number"),
    // Koľký e-mail v poradí to bol (zásielky 1–4) — vďaka nemu je z prehľadu
    // vidno eskaláciu namiesto zdanlivého opakovania (ticketova podmienka
    // "ochrana pred dvojitým odoslaním musí byť z prehľadu viditeľná").
    sequence: integer("sequence"),
    // Čitateľný dôvod pri `failed`/`skipped` — to jediné, čo dnes končí len v
    // serverovom logu, ktorý majiteľ nevidí.
    reason: text("reason"),
    // `set null`, nie `restrict` — zmazanie zamestnanca nesmie zmazať ani
    // zablokovať históriu pošty (na rozdiel od `pairing.confirmed_by`, kde
    // CHECK vyžaduje vyplnené, `.claude/rules/database.md`).
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("mail_log_created_idx").on(t.createdAt), index("mail_log_source_created_idx").on(t.source, t.createdAt)],
);
