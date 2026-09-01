import { customType, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema-users.js";

// issue 519: binárny stĺpec pre hlasovú nahrávku. node-postgres nesie/prijíma
// `bytea` ako `Buffer`, žiadna extra serializácia. Prvé použitie `bytea` v tejto
// appke — krátke poznámky (~30–200 KB) sa ukladajú priamo na riadok `daily_task`
// (nie na disk), takže jazdia na existujúcom DB zálohovaní aj zdieľanom modeli
// (#487); plné odôvodnenie voľby úložiska je v dizajnovom komentári na tickete.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// issue 342 + 487: "Úlohy na dnes" — nahrádza šéfove poznámky písané do Discord
// kanála #úlohy-na-dnes. PÔVODNE súkromný per-`user_id` zoznam (#342); od #487
// ZDIEĽANÝ — každý prihlásený účet vidí a smie odfajknúť/upraviť/zmazať VŠETKY
// úlohy (presne ako `note`/Poznámky, #437). `user_id` stĺpec OSTÁVA, ale už NIE
// ako filter viditeľnosti — je to AUTOR (zapisuje sa zo session pri create,
// `service.ts`, a zobrazuje sa pri riadku). Server vlastníctvo pri čítaní/zápise
// ZÁMERNE nevynucuje (`modules/daily-tasks/queries.ts`/`service.ts`). Zámerne
// SAMOSTATNÁ tabuľka, nie nová `upozornenie.type` hodnota — plné odôvodnenie na
// tickete: Upozornenia sú firemná queue s postpone/resolve/dedupKey sémantikou a
// odznakom, tento zoznam je minimalistická zdieľaná nástenka bez toho všetkého.
export const dailyTask = pgTable(
  "daily_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    // Nepovinné — majiteľ ho pridáva/mení AŽ PO vytvorení úlohy, samostatnou
    // akciou (design komentár na tickete: "písať jedno za druhým", emoji nie
    // je súčasť rýchleho vytvorenia). Obyčajný text stĺpec — appka nevynucuje,
    // že ide o skutočný emoji znak, spolieha sa na to, čo používateľ napíše
    // cez systémový/klávesnicový výber (rozhodnutie na tickete: žiadny
    // vlastný emoji-picker).
    emoji: text("emoji"),
    // `null` = ešte nevybavené. Nastavuje/ruší sa cez jeden atomický UPDATE
    // (`setDailyTaskDone`), nikdy sa nemaže riadok len kvôli prepnutiu stavu.
    doneAt: timestamp("done_at", { withTimezone: true }),
    // issue 519: hlasová nahrávka (Messenger-vzor). Všetky TRI stĺpce sú
    // NULLABLE a menia sa spolu: buď riadok NEMÁ nahrávku (všetky `null`), alebo
    // ju má (všetky vyplnené). ZÁMERNE bez CHECKu, ktorý by ich viazal —
    // `.claude/rules/database.md` dokumentuje pascu s dvoj/troj-stĺpcovým
    // CHECKom; appka drží invariant v jedinej zapisovacej ceste
    // (`createVoiceDailyTask`/`deleteDailyTaskAudio`), nie v schéme. `audio` sa
    // NIKDY nevyberá do zoznamu/odznaku (len `hasAudio` boolean) — streamuje sa
    // samostatnou trasou `GET /api/daily-tasks/:id/audio`.
    audio: bytea("audio"),
    // MIME nahrávky presne ako ho nahlásil prehliadač (`audio/webm;codecs=opus`,
    // `audio/mp4`, …) — použije sa ako `Content-Type` pri prehrávaní.
    audioMime: text("audio_mime"),
    // Dĺžka nahrávky v ms z KLIENTSKEHO časovača — `<audio>` element pri webm
    // hlási `Infinity`, preto sa berie z merania počas nahrávania, nie z média.
    audioDurationMs: integer("audio_duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Index z pôvodnej per-user sémantiky (#342). Od #487 sa zoznam číta
    // ZDIEĽANE (zoradený "najnovšie hore", bez `user_id` filtra), takže tento
    // zložený `(user_id, created_at)` index už nie je pre čítanie optimálny —
    // PONECHÁVA SA ZÁMERNE bez zmeny (#487 nerobí ŽIADNU migráciu; pri 22
    // riadkoch je rozdiel nepodstatný). Prípadné pretypovanie indexu na samotný
    // `created_at` je vec budúcej migrácie, nie tejto zmeny správania.
    index("daily_task_user_id_created_at_idx").on(t.userId, t.createdAt),
  ],
);
