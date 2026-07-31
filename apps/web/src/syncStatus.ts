import type { JobRun } from "./schedulerApi.js";

// #115 (majiteľ: "sync zo shoptetu ma bezat kazdu hodinu, nemoze tam bezat
// ok ked posledny sync bol dni dozadu!!!") — jediné miesto, ktoré rozhoduje
// stav "Sync zo Shoptetu" pillu. Predtým `SyncSection.tsx`'s `IngestChannel`
// rozhodoval o zelenej VÝLUČNE podľa `run?.status === "failure"`, vek
// posledného behu sa nikde neporovnával s ničím.
export type SyncStatusKind = "never" | "ok" | "stale" | "error";

export interface SyncStatus {
  readonly kind: SyncStatusKind;
  readonly pillClass: "on" | "off";
  readonly pillText: string;
  // Vyplnené LEN pre "stale" — samostatný varovný riadok pod pillom
  // s vekom posledného úspešného behu ("Posledný úspešný sync: pred 3
  // dňami — synchronizácia nebeží.").
  readonly warningText: string | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Prah zastaranosti = 2× nakonfigurovaná kadencia danej úlohy
// (`apps/api/src/modules/scheduler/jobs.ts`) — nie natvrdo zapísané magické
// číslo odpojené od skutočného rozvrhu. Objednávky: hodinová kadencia (#115)
// → 2 h (presne príklad z issue). Katalóg: zostáva denná kadencia (#115 ju
// nemení) → 48 h. Obe "Sync zo Shoptetu" políčka zdieľajú TEN ISTÝ
// `IngestChannel` komponent, takže rovnaký druh chyby (ignorovanie veku)
// platil identicky pre oba kanály.
export const ORDERS_STALE_AFTER_MS = 2 * HOUR_MS;
export const CATALOG_STALE_AFTER_MS = 2 * DAY_MS;

// Jednoduché dvojtvarové skloňovanie (1 vs. viac) — rovnaká úroveň
// jednoduchosti, akú repo už používa pre vek objednávky
// (`ordersSummary.ts`'s `orderLineAgeDays`, vždy len "N dní" bez ohľadu na
// N). Formát "pred 3 dňami" doslovne zodpovedá majiteľovmu vlastnému
// zneniu v zadaní issue.
function formatAge(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 24) return hours === 1 ? "hodinou" : `${String(hours)} hodinami`;
  const days = Math.floor(ms / DAY_MS);
  return days === 1 ? "dňom" : `${String(days)} dňami`;
}

export function computeSyncStatus(run: JobRun | undefined, now: Date, staleAfterMs: number): SyncStatus {
  if (run === undefined) {
    // Nikdy nebežalo → nesmie sa tváriť ako zelené "OK" (rovnaký princíp,
    // aký táto oprava zavádza pre zastaraný beh) — text ostáva "zatiaľ nič"
    // (nezmenené, `lastRunLine` ukazuje detail vedľa neho).
    return { kind: "never", pillClass: "off", pillText: "zatiaľ nič", warningText: null };
  }
  if (run.status === "failure") {
    return { kind: "error", pillClass: "off", pillText: "❌ CHYBA", warningText: null };
  }
  if (run.status === "running") {
    // Prebiehajúci beh nemá zmysluplný "vek" na porovnanie s prahom —
    // ostáva "ok" ako doteraz.
    return { kind: "ok", pillClass: "on", pillText: "✅ OK", warningText: null };
  }
  const ageMs = now.getTime() - new Date(run.startedAt).getTime();
  if (ageMs <= staleAfterMs) {
    return { kind: "ok", pillClass: "on", pillText: "✅ OK", warningText: null };
  }
  return {
    kind: "stale",
    pillClass: "off",
    pillText: "⚠️ ZASTARANÉ",
    warningText: `Posledný úspešný sync: pred ${formatAge(ageMs)} — synchronizácia nebeží.`,
  };
}
