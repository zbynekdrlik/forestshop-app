import type { Database } from "../../db/client.js";

// Denná schéma vyjadrená ako presná hodina:minúta v UTC — najjednoduchšia vec,
// ktorá pokrýva "spusti raz za noc" bez potreby cron-výrazového parsera. Úloha
// je "splatná" v danom ticku, keď aktuálny UTC čas dosiahol/prekročil tento
// bod a dnes (podľa UTC kalendárneho dňa) ešte nebežala — viď `isDue`
// v scheduler.ts.
export interface DailySchedule {
  readonly hourUtc: number;
  readonly minuteUtc: number;
}

export interface JobOutcome {
  readonly detail?: unknown;
}

export interface ScheduledJob {
  readonly name: string;
  readonly schedule: DailySchedule;
  run(db: Database, now: Date): Promise<JobOutcome>;
}
