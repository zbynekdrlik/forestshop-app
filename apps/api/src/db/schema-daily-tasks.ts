import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema-users.js";

// issue 342: "Úlohy na dnes" — nahrádza šéfove poznámky písané do Discord
// kanála #úlohy-na-dnes. ÚPLNE osobný zoznam, viazaný na `user_id` — každý
// prihlásený používateľ vidí a upravuje LEN svoje vlastné riadky, server to
// vynucuje na každom endpointe (`modules/daily-tasks/service.ts`), nikdy len
// frontend. Zámerne SAMOSTATNÁ tabuľka, nie nová `upozornenie.type` hodnota —
// plné odôvodnenie na tickete (design komentár pred prvým commitom kódu):
// Upozornenia sú zdieľaná firemná queue s postpone/resolve/dedupKey
// sémantikou a odznakom pre VŠETKÝCH zamestnancov, tento zoznam je súkromný
// poznámkový blok bez toho všetkého.
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Zoznam sa vždy číta zoradený "najnovšie hore" A vždy filtrovaný na
    // JEDNÉHO používateľa naraz (`.claude/rules/database.md` — index podľa
    // toho, ako sa dáta SKUTOČNE čítajú).
    index("daily_task_user_id_created_at_idx").on(t.userId, t.createdAt),
  ],
);
