import { customType, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema-users.js";

// issue 543: "SLAVOSPORT → Úhrady" — miesto, kde si šéfov kolega Štěpán nahrá
// naskenované papierové faktúry (FA) od dodávateľov, ktoré treba uhradiť, a
// jednoriadkové poznámky navrchu (ako „Úlohy na dnes", ale BEZ hlasu/audio).
// Obe tabuľky sú ZDIEĽANÉ (žiadny per-user filter — presne ako `note`/#437 a
// `daily_task` od #487): každý prihlásený vidí a smie pridať/upraviť/zmazať
// všetko; `user_id` OSTÁVA ako AUTOR (zo session pri create). Zámerne
// SAMOSTATNÉ tabuľky, nie nové príznaky na `note`/`daily_task` — je to vlastná
// sekcia s vlastnou sémantikou (obrázok + popis), plné odôvodnenie v dizajnovom
// komentári na tickete.

// `bytea` — surové bajty obrázka na riadku (rovnaký vzor ako `daily_task.audio`,
// #519). node-postgres nesie/prijíma `Buffer` bez extra serializácie.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// Jednoriadkové poznámky navrchu obrazovky. Minimalistické — zadanie žiada len
// pridať/zoznam/zmazať (žiadny `resolved_at`/emoji ako pri `daily_task`).
export const slavosportPaymentNote = pgTable(
  "slavosport_payment_note",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Autor zo session (nikdy z tela requestu). `cascade` ako `note`/`daily_task`
    // — zamestnancov je pevná malá množina; ak by účet zanikol, jeho poznámky
    // zmiznú s ním (prijateľné pre MVP nástenku).
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Zoznam sa vždy číta „najnovšie hore" a je ZDIEĽANÝ (žiadny per-user
    // filter) — index podľa toho, ako sa dáta SKUTOČNE čítajú
    // (`.claude/rules/database.md`), rovnako ako `note_created_at_idx`.
    index("slavosport_payment_note_created_at_idx").on(t.createdAt),
  ],
);

// Nahraný sken FA. `image` (bytea) sa NIKDY nevyberá do zoznamu/odznaku — inak
// by sa poll nafúkol na megabajty (presne lekcia `.claude/rules/daily-tasks.md`
// pri `daily_task.audio`). Streamuje sa samostatnou trasou
// `GET /api/uhrady/scans/:id/image`; grid ho vykreslí zmenšený cez CSS
// `object-fit` (rozhodnutie v dizajne: originál-only, žiadna thumbnail
// pipeline — Úhrady sú tranzitný zoznam nezaplatených FA, malý pracovný set).
export const slavosportPaymentScan = pgTable(
  "slavosport_payment_scan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Surové bajty obrázka (jpg/png). Úložisko = riadok, NIE disk (appka je
    // jeden bezstavový kontajner; DB je jediné trvalé úložisko + záloha) —
    // rovnaký model ako `daily_task.audio`.
    image: bytea("image").notNull(),
    // MIME presne ako ho nahlásil prehliadač (allowlist image/jpeg|image/png,
    // vynútený v trase) — použije sa ako `Content-Type` pri streamovaní.
    imageMime: text("image_mime").notNull(),
    // Popis pod thumbnailom (šéf ho dopĺňa/mení po nahratí). `notNull` s
    // defaultom `''` — jednoduchší invariant než nullable (vždy string).
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("slavosport_payment_scan_created_at_idx").on(t.createdAt)],
);
