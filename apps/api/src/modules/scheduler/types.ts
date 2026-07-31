import type { Database } from "../../db/client.js";

// Denná schéma vyjadrená ako presná hodina:minúta v UTC — najjednoduchšia vec,
// ktorá pokrýva "spusti raz za noc" bez potreby cron-výrazového parsera. Úloha
// je "splatná" v danom ticku, keď aktuálny UTC čas dosiahol/prekročil tento
// bod a dnes (podľa UTC kalendárneho dňa) ešte nebežala — viď `isDue`
// v scheduler.ts.
export interface DailySchedule {
  readonly kind: "daily";
  readonly hourUtc: number;
  readonly minuteUtc: number;
}

// Hodinová schéma (#115) — rovnaký princíp ako `DailySchedule`, len s
// jemnejšou periódou: úloha je "splatná" v danom ticku, keď aktuálna UTC
// minúta dosiahla/prekročila `minuteUtc` A v tejto UTC hodine ešte nebežala.
// Zámerne DISKRIMINOVANÁ ÚNIA s `DailySchedule` (spoločné pole `kind`),
// nie jeden preťažený tvar s voliteľným flagom — vylučuje nezmyselné
// kombinácie (napr. `everyHour` + nastavené `hourUtc` súčasne) a zodpovedá
// existujúcemu štýlu repa (`CatalogIngestOutcome`/`OrdersIngestOutcome`
// diskriminujú podľa `status`).
export interface HourlySchedule {
  readonly kind: "hourly";
  readonly minuteUtc: number;
}

export type Schedule = DailySchedule | HourlySchedule;

export interface JobOutcome {
  readonly detail?: unknown;
}

export interface ScheduledJob {
  readonly name: string;
  readonly schedule: Schedule;
  run(db: Database, now: Date): Promise<JobOutcome>;
}
