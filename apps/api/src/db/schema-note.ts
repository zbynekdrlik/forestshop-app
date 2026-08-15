import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema-users.js";

// issue 437: "Poznámky" — rýchly mobilný zápis do appky (PWA, ZDIEĽANÝ zoznam).
// Na rozdiel od `daily_task` (#342, ktorý je SÚKROMNÝ per `user_id` a server
// vlastníctvo vynucuje na každom dopyte) sú Poznámky ZDIEĽANÉ: vidí ich KAŽDÝ
// prihlásený používateľ, autor je zobrazený, a ktokoľvek prihlásený môže
// poznámku vybaviť/zmazať — slúžia na spracovanie tímom, nie sú súkromné
// (rozhodnutie na tickete: „zdieľané, nie súkromné"). Zámerne SAMOSTATNÁ
// tabuľka, nie nová `daily_task` príznaková hodnota ani `upozornenie.type` —
// plné odôvodnenie v design komentári pred prvým commitom kódu (Upozornenia
// sú firemná fronta s dedupKey/postpone/odznakom, `daily_task` je súkromný;
// Poznámky sú minimalistická zdieľaná zapisovacia nástenka bez toho všetkého).
export const note = pgTable(
  "note",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Autor sa ukladá zo session (`authorUserId`), nikdy z tela requestu.
    // `onDelete: "cascade"` rovnako ako `daily_task` — zamestnancov je pevná
    // malá množina, ktorá sa prakticky nemaže; ak by účet predsa zanikol,
    // jeho poznámky zmiznú spolu s ním (prijateľné pre MVP nástenku).
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    // `null` = aktívna, čas = vybavená/archivovaná. Nastavuje/ruší sa jedným
    // atomickým UPDATE (`setNoteResolved`), riadok sa pri prepnutí NIKDY
    // nemaže — mazanie je samostatná akcia (`deleteNote`).
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Zoznam sa vždy číta zoradený „najnovšie hore" a je ZDIEĽANÝ (žiadny
    // per-user filter, na rozdiel od `daily_task`) — index podľa toho, ako
    // sa dáta SKUTOČNE čítajú (`.claude/rules/database.md`).
    index("note_created_at_idx").on(t.createdAt),
  ],
);
