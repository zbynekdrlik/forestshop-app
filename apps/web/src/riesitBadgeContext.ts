import { createContext } from "react";

// issue 476: most medzi obrazovkami, ktoré menia počet riadkov v stave
// `riesit` (`OrdersSection` = klik na tlačidlo Riešiť v „Na objednanie";
// `RiesitSection` = zmena stavu / rýchle pole), a `App.tsx` (vlastní odznak
// „Riešiť" v ľavom menu, `badgeCounts`). Rovnaký vzor ako
// `dailyTasksBadgeContext.ts`/`floorNotesBadgeContext.ts` (issue 473) —
// context nesie LEN účinok „počet riesit riadkov sa mohol zmeniť", `App.tsx`
// si count naďalej načítava a vlastní SÁM (musí byť známy hneď po prihlásení,
// nie až po prvom otvorení záložky), len dostáva DRUHÝ spúšťač refetchu okrem
// zmeny záložky. Obe sekcie ho musia volať po KAŽDEJ zmene stavu, lebo obe
// môžu riadok do stavu `riesit` pridať aj z neho odobrať.
export interface RiesitBadgeRefreshContextValue {
  readonly refresh: () => void;
}

export const RiesitBadgeRefreshContext = createContext<RiesitBadgeRefreshContextValue>({
  refresh: () => {
    // Predvolená hodnota mimo Provider-a (napr. test, čo rendruje sekciu
    // samostatne bez App.tsx) — bezpečné no-op.
  },
});
