// issue 447 — mapovanie stavu automatizácií pre pilulky „Beží"/„Zastavené"
// v ľavom menu (`Sidebar.tsx` renderuje pilulku pre KAŽDÝ `badgeStatus[tab.id]`).
// Vyčlenené z `App.tsx`'s efektu ako ČISTÁ funkcia, aby sa mapovanie dalo
// otestovať bez Reactu. Pilulka = „automatizácia je ZAPNUTÁ" (Štart/Stop
// prepínač), NIE živé vykonávanie jobu — job beží pár minút v noci, živý stav
// ostáva lokálnym ⏳ na obrazovke jobu (design komentár na issue 447).

export type AutomationStatus = "on" | "off";

// always-on plánované joby BEZ Štart/Stop prepínača (`supplier-stock` =
// „Dodávateľský sklad", `sync` = „Sync zo Shoptetu" — joby `catalog-import` +
// `orders-import`). Nemajú koncept „vypnuté", takže pilulka „Beží" trvalo;
// odvodené staticky, žiadne API netreba. Tab id-čka zodpovedajú `nav.ts`.
export const STATIC_AUTOMATION_STATUS: Readonly<Record<string, AutomationStatus>> = {
  "supplier-stock": "on",
  sync: "on",
};

// Togglované automatizácie (majú DB `enabled` flag / Štart/Stop): „Beží" keď
// zapnuté, „Zastavené" keď vypnuté. `restock` = „Vypredané → Skladom" (issue
// 447 — doteraz chýbalo), `posta-uncollected` = „Nevyzdvihnuté zásielky",
// `order-reminder` = „Pripomienky objednávok" (pôvodný rozsah, issue 185).
export function buildAutomationStatus(inputs: {
  readonly postaUncollected: boolean;
  readonly orderReminder: boolean;
  readonly restock: boolean;
}): Record<string, AutomationStatus> {
  return {
    ...STATIC_AUTOMATION_STATUS,
    "posta-uncollected": inputs.postaUncollected ? "on" : "off",
    "order-reminder": inputs.orderReminder ? "on" : "off",
    restock: inputs.restock ? "on" : "off",
  };
}
