import type { Database } from "../../db/client.js";

// Denná schéma vyjadrená ako presná hodina:minúta v MIESTNOM (Europe/
// Bratislava) čase — najjednoduchšia vec, ktorá pokrýva "spusti raz za noc"
// bez potreby cron-výrazového parsera. Úloha je "splatná" v danom ticku,
// keď aktuálny miestny čas dosiahol/prekročil tento bod a dnes (podľa
// MIESTNEHO kalendárneho dňa) ešte nebežala — viď `isDue` v scheduler.ts.
// Issue 293: predtým `hourUtc`/`minuteUtc` interpretované doslova ako UTC —
// appka aj kontajner bežali v UTC, takže úloha nastavená na 7:00 sa v
// skutočnosti spustila až o 9:00 (v zime 8:00) slovenského času. Polia sú
// premenované na `hourLocal`/`minuteLocal`, aby meno zodpovedalo tomu, ako
// sa hodnota SKUTOČNE číta — číselné hodnoty v `jobs.ts` ostali NEZMENENÉ,
// zmenil sa len ich VÝZNAM.
export interface DailySchedule {
  readonly kind: "daily";
  readonly hourLocal: number;
  readonly minuteLocal: number;
}

// Hodinová schéma (#115) — rovnaký princíp ako `DailySchedule`, len s
// jemnejšou periódou: úloha je "splatná" v danom ticku, keď aktuálna UTC
// minúta dosiahla/prekročila `minuteUtc` A v tejto UTC hodine ešte nebežala.
// Zámerne DISKRIMINOVANÁ ÚNIA s `DailySchedule` (spoločné pole `kind`),
// nie jeden preťažený tvar s voliteľným flagom — vylučuje nezmyselné
// kombinácie (napr. `everyHour` + nastavené `hourLocal` súčasne) a zodpovedá
// existujúcemu štýlu repa (`CatalogIngestOutcome`/`OrdersIngestOutcome`
// diskriminujú podľa `status`).
//
// `minuteUtc` (nie `minuteLocal`) je ZÁMERNÉ a ZOSTÁVA po issue 293 — na
// rozdiel od `DailySchedule` hodinový job nemá cieľovú HODINU (beží v
// KAŽDEJ hodine), len minútu v rámci hodiny. Minúta v rámci hodiny je v
// Europe/Bratislava (celohodinový offset, vždy +1 alebo +2) rovnaká v UTC
// aj v miestnom čase — preto sa netreba lokalizovať, a jej `periodKey`
// (`scheduler.ts`) ZÁMERNE ostáva podľa UTC dňa+hodiny (jednoznačné,
// monotónne, bez rizika opakovanej miestnej hodiny 02:00-03:00 v deň
// prechodu na zimný čas — viď komentár pri `periodKey`).
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
