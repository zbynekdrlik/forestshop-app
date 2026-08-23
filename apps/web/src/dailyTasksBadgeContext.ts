import { createContext } from "react";

// issue 473: most medzi `DailyTasksSection` (mutuje dáta) a `App.tsx` (vlastní
// odznak v ľavom menu, `badgeCounts`). Rovnaký vzor ako
// `upozorneniaBadgeContext.ts` — context nesie LEN účinok "niečo sa zmenilo",
// `App.tsx` si count naďalej načítava a vlastní SÁM (musí byť známy hneď po
// prihlásení, nie až po prvom otvorení záložky), len dostáva DRUHÝ spúšťač
// refetchu okrem zmeny záložky.
export interface DailyTasksBadgeRefreshContextValue {
  readonly refresh: () => void;
}

export const DailyTasksBadgeRefreshContext = createContext<DailyTasksBadgeRefreshContextValue>({
  refresh: () => {
    // Predvolená hodnota mimo Provider-a (napr. test, čo rendruje
    // DailyTasksSection samostatne bez App.tsx) — bezpečné no-op.
  },
});
