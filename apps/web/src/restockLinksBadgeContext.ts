import { createContext } from "react";

// issue 331: most medzi `RestockLinkSuggestionsSection` (mutuje dáta —
// potvrdenie kandidáta) a `App.tsx` (vlastní odznak v ľavom menu,
// `badgeCounts`) — presne rovnaký vzor a dôvod ako `UpozorneniaBadgeRefreshContext`
// (issue 267, gap 1). `App.tsx` si count naďalej načítava a vlastní SÁM
// (musí byť známy hneď po prihlásení, nie až po prvom otvorení tejto
// záložky), tento context nesie LEN účinok "niečo sa práve zmenilo".
export interface RestockLinksBadgeRefreshContextValue {
  readonly refresh: () => void;
}

export const RestockLinksBadgeRefreshContext = createContext<RestockLinksBadgeRefreshContextValue>({
  refresh: () => {
    // Predvolená hodnota mimo Provider-a (napr. test, čo rendruje
    // RestockLinkSuggestionsSection samostatne bez App.tsx) — bezpečné no-op.
  },
});
