import { createContext } from "react";

// issue 445: most medzi `DpdSection` (odošle zásielky, tým sa zoznam
// zmenší) a `App.tsx` (vlastní nav odznak „Objednať DPD", `badgeCounts`).
// Presne rovnaký vzor ako `upozorneniaBadgeContext.ts`: NENESIE hodnotu —
// count si `App.tsx` načítava a vlastní SÁM (musí byť známy hneď po
// prihlásení, nie až po prvom otvorení záložky), tento context nesie len
// účinok „niečo sa zmenilo", aby po úspešnom odoslaní číslo v menu HNEĎ
// kleslo (druhý spúšťač refetchu okrem zmeny záložky).
export interface DpdBadgeRefreshContextValue {
  readonly refresh: () => void;
}

export const DpdBadgeRefreshContext = createContext<DpdBadgeRefreshContextValue>({
  refresh: () => {
    // Predvolená hodnota mimo Provider-a (napr. test, čo rendruje
    // DpdSection samostatne bez App.tsx) — bezpečné no-op.
  },
});
