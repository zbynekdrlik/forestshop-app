import { createContext } from "react";

// issue 290: rovnaký most ako `upozorneniaBadgeContext.ts` (issue 267) — most
// medzi `ClaimOrdersSection` (jediná z troch nových obrazoviek, čo MUTUJE
// dáta — označenie/zrušenie reklamácie) a `App.tsx` (vlastní odznaky v
// ľavom menu, `badgeCounts`). Nesie LEN účinok "niečo sa zmenilo" —
// `App.tsx` si počty naďalej načítava a vlastní SÁM (musí byť známe hneď
// po prihlásení, nie až po prvom otvorení záložky), len teraz dostáva aj
// DRUHÝ spúšťač refetchu okrem zmeny záložky.
export interface OrderFlagsBadgeRefreshContextValue {
  readonly refresh: () => void;
}

export const OrderFlagsBadgeRefreshContext = createContext<OrderFlagsBadgeRefreshContextValue>({
  refresh: () => {
    // Predvolená hodnota mimo Provider-a (napr. test, čo rendruje
    // ClaimOrdersSection samostatne bez App.tsx) — bezpečné no-op.
  },
});
