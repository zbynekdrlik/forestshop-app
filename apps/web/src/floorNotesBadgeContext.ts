import { createContext } from "react";

// issue 473: most medzi `FloorNotesSection` (mutuje dáta) a `App.tsx` (vlastní
// odznak v ľavom menu, `badgeCounts`). Rovnaký vzor ako
// `upozorneniaBadgeContext.ts`/`dailyTasksBadgeContext.ts` — context nesie LEN
// účinok "niečo sa zmenilo", `App.tsx` si count naďalej načítava a vlastní SÁM.
export interface FloorNotesBadgeRefreshContextValue {
  readonly refresh: () => void;
}

export const FloorNotesBadgeRefreshContext = createContext<FloorNotesBadgeRefreshContextValue>({
  refresh: () => {
    // Predvolená hodnota mimo Provider-a (napr. test, čo rendruje
    // FloorNotesSection samostatne bez App.tsx) — bezpečné no-op.
  },
});
