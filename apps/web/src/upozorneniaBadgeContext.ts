import { createContext } from "react";

// issue 267 (živé overenie, gap 1): most medzi `UpozorneniaSection`
// (mutuje dáta) a `App.tsx` (vlastní odznak v ľavom menu, `badgeCounts`).
// Na rozdiel od `OrdersRemainingCountContext` (ten nesie SAMOTNÚ hodnotu,
// lebo ju publikuje priamo obrazovka) tento context nesie LEN účinok
// "niečo sa zmenilo" — `App.tsx` si count naďalej načítava a vlastní SÁM
// (musí byť známy hneď po prihlásení, nie až po prvom otvorení záložky,
// pôvodné návrhové rozhodnutie na tickete), len teraz dostáva aj DRUHÝ
// spúšťač refetchu okrem zmeny záložky.
export interface UpozorneniaBadgeRefreshContextValue {
  readonly refresh: () => void;
}

export const UpozorneniaBadgeRefreshContext = createContext<UpozorneniaBadgeRefreshContextValue>({
  refresh: () => {
    // Predvolená hodnota mimo Provider-a (napr. test, čo rendruje
    // UpozorneniaSection samostatne bez App.tsx) — bezpečné no-op.
  },
});
