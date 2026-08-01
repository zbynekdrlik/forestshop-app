import { createContext } from "react";

// issue 147 — most jednoduchý mostík medzi `OrdersSection` (vlastník dát) a
// `Sidebar`/`App.tsx` (potrebujú len ODVODENÝ počet, nie celé dáta). Provider
// žije raz v `App.tsx` (spoločný predok Sidebar-u aj `ActiveComponent`-u), takže
// hodnota PREŽIJE prepnutie na inú záložku (na rozdiel od stavu vnútri
// `OrdersSection`, ktorý sa pri odmountovaní stratí) — odznak tak ukazuje
// poslednú známu hodnotu, nie "zmizne, kým sa tab znova nenavštívi".
// `count === null` = appka ešte nevie (OrdersSection ešte nikdy nenačítala
// dáta v tejto relácii) — Sidebar vtedy odznak vôbec nevykreslí.
export interface OrdersRemainingCountContextValue {
  readonly count: number | null;
  readonly setCount: (count: number | null) => void;
}

export const OrdersRemainingCountContext = createContext<OrdersRemainingCountContextValue>({
  count: null,
  setCount: () => {
    // Predvolená hodnota mimo Provider-a (napr. v teste, ktorý OrdersSection
    // rendruje samostatne) — bezpečné no-op, nikdy nespadne.
  },
});
