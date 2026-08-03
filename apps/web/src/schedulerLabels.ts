import type { JobRun } from "./schedulerApi.js";

// Zdieľané medzi `SchedulerSection.tsx` (skrytá, priama `/plánovač` obrazovka)
// a `SyncSection.tsx` (viditeľná "Sync zo Shoptetu") — JEDEN zdroj pravdy pre
// slovenské pomenovanie job-ov, aby sa pri pridaní ďalšieho jobu nezabudlo na
// jedno z dvoch miest. Rozšírené o "orders-import"/"prune-raw-orders" (#22/#28)
// — predtým chýbali, takže sa zobrazoval holý technický názov jobu namiesto
// slovenského popisu. Issue 185 (majiteľ si všimol holé technické názvy v
// tabuľke "História behov"): doplnené "posta-uncollected"/"order-reminder"
// (rovnaké slovenské názvy ako ich `NavTab.label` v `nav.ts`) a
// "shoptet-writeback"/"order-note-writeback" (skrátené znenie ich
// "*_NOT_CONFIGURED" hlášok v `modules/scheduler/jobs.ts` — sem sa zmestí
// len krátky popis stĺpca "Úloha", nie celá veta).
export const JOB_LABELS: Readonly<Record<string, string>> = {
  "catalog-import": "Import katalógu",
  "prune-raw-exports": "Mazanie starých surových exportov (katalóg)",
  "session-cleanup": "Mazanie expirovaných relácií",
  "orders-import": "Import objednávok",
  "prune-raw-orders": "Mazanie starých surových exportov (objednávky)",
  "posta-uncollected": "Nevyzdvihnuté zásielky",
  "order-reminder": "Pripomienky objednávok",
  "shoptet-writeback": "Spätný zápis dodávateľa do Shoptetu",
  "order-note-writeback": "Spätný zápis poznámky do Shoptetu",
};

export const STATUS_LABELS: Record<JobRun["status"], string> = {
  running: "Beží",
  success: "Úspešná",
  failure: "Zlyhala",
};

export function jobLabel(jobName: string): string {
  return JOB_LABELS[jobName] ?? jobName;
}

export function detailText(run: JobRun): string {
  if (run.status === "failure") return run.errorMessage ?? "—";
  if (run.detail === null || run.detail === undefined) return "—";
  return JSON.stringify(run.detail);
}
