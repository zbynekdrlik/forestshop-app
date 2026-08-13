import { createContext } from "react";

// issue 387 E6 — most medzi `PairingReviewSection`/`PairingReviewCard`
// (mutujú dáta — rozhodnutie o produkte) a `App.tsx` (vlastní odznak v
// ľavom menu, `badgeCounts`) — presne rovnaký vzor a dôvod ako
// `RestockLinksBadgeRefreshContext` (issue 331). `App.tsx` si count naďalej
// načítava a vlastní SÁM (musí byť známy hneď po prihlásení, nie až po
// prvom otvorení tejto záložky), tento context nesie LEN účinok "niečo sa
// práve zmenilo".
export interface PairingReviewBadgeRefreshContextValue {
  readonly refresh: () => void;
}

export const PairingReviewBadgeRefreshContext = createContext<PairingReviewBadgeRefreshContextValue>({
  refresh: () => {
    // Predvolená hodnota mimo Provider-a (napr. test, čo rendruje
    // PairingReviewSection samostatne bez App.tsx) — bezpečné no-op.
  },
});
