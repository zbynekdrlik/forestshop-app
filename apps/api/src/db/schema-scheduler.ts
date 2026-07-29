import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Jeden riadok na KAŽDÝ pokus o beh naplánovanej úlohy (F2) — vkladá sa PRED
// spustením (`status: "running"`) a aktualizuje sa PO dobehnutí na
// "success"/"failure". Toto je scheduler-úrovňová viditeľnosť, nezávislá od
// bohatšieho záznamu, ktorý si import katalógu už vedie sám
// (`catalog_snapshot`) — `job_run` existuje aj pre úlohy, ktoré si vlastný
// záznam nevedú (mazanie surových exportov, mazanie relácií), a dáva
// operátorovi JEDNO miesto, kde vidí posledný beh VŠETKÝCH troch úloh.
export const jobRunStatus = pgEnum("job_run_status", ["running", "success", "failure"]);

export const jobRuns = pgTable(
  "job_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobName: text("job_name").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: jobRunStatus("status").notNull().default("running"),
    // Štruktúrovaný výsledok úlohy (napr. { removed: N } / { deletedCount: N }
    // / výsledok importu) — voľný tvar, lebo každá úloha má iný užitočný
    // detail; UI si ho zobrazuje ako JSON, nie je potrebná spoločná schéma.
    detail: jsonb("detail"),
    // Len pri "failure" — vyhodená výnimka odchytená schedulerom (nikdy
    // nezostáva nezachytená, viď scheduler.ts). Nikdy sa nezobrazuje
    // neprihlásenému používateľovi, len rolám admin/manazer cez
    // /api/scheduler/runs, rovnaká citlivosť ako ostatné interné logy.
    errorMessage: text("error_message"),
  },
  (t) => [index("job_run_name_started_idx").on(t.jobName, t.startedAt)],
);
