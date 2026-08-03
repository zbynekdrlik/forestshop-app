import type { ComponentType } from "react";
import type { Me } from "./api.js";
import { CatalogPage } from "./components/CatalogPage.js";
import { NedostupneSection } from "./components/NedostupneSection.js";
import { OrderReminderSection } from "./components/OrderReminderSection.js";
import { OrdersSection } from "./components/OrdersSection.js";
import { PairingSection } from "./components/PairingSection.js";
import { PostaUncollectedSection } from "./components/PostaUncollectedSection.js";
import { SchedulerSection } from "./components/SchedulerSection.js";
import { SyncSection } from "./components/SyncSection.js";

// Spoločný tvar props pre KAŽDÚ obrazovku registrovanú tu — presne to, čo dnes
// prijíma CatalogPage/OrdersSection/PairingSection/SchedulerSection/SyncSection.
export interface SectionProps {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}

export interface NavTab {
  readonly id: string;
  readonly label: string;
  readonly Component: ComponentType<SectionProps>;
  // issue 95: `true` pre obrazovky, ktoré potrebujú viac než pohodlnú čítaciu
  // šírku (`--fs-content-width`, 1120px) — hustá pracovná tabuľka ("Na
  // objednanie") sa inak nikdy nerozšíri na šírku okna nad týmto stropom.
  // `App.tsx` na základe tohto pridá `<main>`u triedu `main-wide`
  // (`app.css`), ktorá strop zruší LEN pre túto jednu záložku — ostatné
  // (Sync/Katalóg/Párovanie/Plánovač) ostávajú na pôvodnej čítacej šírke.
  readonly wide?: boolean;
}

export interface NavFolder {
  readonly id: string;
  readonly label: string;
  readonly tabs: readonly NavTab[];
}

// Ľavé menu — VIDITEĽNÉ položky. Pôvodne (issue 57, 2026-07-30) majiteľ chcel
// naľavo zatiaľ len "Sync zo Shoptetu"/"Na objednanie" — platilo, kým tri
// automatizácie nižšie neboli hotové. Issue 185 (2026-08-03, majiteľ:
// "nevidim tam zalozku automatizacie a tie automatizacie spravene") pridáva
// tretí priečinok "Automatizácie" s tromi hotovými obrazovkami, ktoré dovtedy
// sedeli len v `HIDDEN_TABS` bez odkazu v menu. Pridanie ĎALŠEJ položky do
// menu = jeden riadok v niektorom z polí nižšie, žiadna úprava
// App.tsx/Sidebar.tsx.
export const NAV: readonly NavFolder[] = [
  {
    id: "system",
    label: "Systém",
    tabs: [{ id: "sync", label: "Sync zo Shoptetu", Component: SyncSection }],
  },
  {
    id: "eshop",
    label: "Eshop",
    tabs: [{ id: "orders", label: "Na objednanie", Component: OrdersSection, wide: true }],
  },
  {
    id: "automations",
    label: "Automatizácie",
    // Poradie podľa dôležitosti (issue 185, zadanie majiteľa). `wide: true`
    // len pri "Nedostupné tovary" (rovnaký dôvod ako "Na objednanie" nižšie —
    // karty so zoznamom objednávok profitujú z celej šírky okna).
    tabs: [
      { id: "posta-uncollected", label: "Nevyzdvihnuté zásielky", Component: PostaUncollectedSection },
      { id: "order-reminder", label: "Pripomienky objednávok", Component: OrderReminderSection },
      { id: "nedostupne", label: "Nedostupné tovary", Component: NedostupneSection, wide: true },
    ],
  },
];

// Existujúce obrazovky (katalóg, kontrola párovania, plánovač) — majiteľ
// povedal "zatiaľ" o ich neprítomnosti v menu, takže sa NEODSTRAŇUJÚ z kódu,
// len sa nezobrazujú v `NAV` vyššie. Dostupné jedine cez priamy odkaz
// `?tab=<id>` (žiadne tlačidlo/nav-položka v UI) — presne cez tento odkaz si
// ich ďalej overuje ich vlastné e2e pokrytie (catalog.spec.ts/pairing.spec.ts),
// bez potreby vystaviť ich v ľavom menu.
export const HIDDEN_TABS: Readonly<Record<string, NavTab>> = {
  catalog: { id: "catalog", label: "Katalóg", Component: CatalogPage },
  pairing: { id: "pairing", label: "Kontrola párovania", Component: PairingSection },
  scheduler: { id: "scheduler", label: "Plánovač", Component: SchedulerSection },
};

export const DEFAULT_TAB_ID: string = NAV[0]?.tabs[0]?.id ?? "sync";

/** Nájde záložku podľa id — najprv medzi viditeľnými (NAV), potom v skrytých. */
export function findTab(id: string): NavTab | undefined {
  for (const folder of NAV) {
    const found = folder.tabs.find((t) => t.id === id);
    if (found !== undefined) return found;
  }
  return HIDDEN_TABS[id];
}

/**
 * `true` len pre záložky VIDITEĽNÉ v ľavom menu (`NAV` vyššie — dnes Sync zo
 * Shoptetu/Na objednanie/tri automatizácie z issue 185). Skryté obrazovky
 * (katalóg/párovanie/plánovač) si držia svoj PÔVODNÝ vlastný `<h2>` nadpis
 * nezmenený (existujúce e2e naň spoliehajú) — `App.tsx` preto pre ne
 * Topbar-ov `<h1>` titulok VYNECHÁVA, aby nevznikol duplicitný nadpis s
 * rovnakým textom. Issue 185: keď sa obrazovka presunie z `HIDDEN_TABS` do
 * `NAV`, jej vlastný `<h2>` sa musí odstrániť (viď
 * PostaUncollectedSection/OrderReminderSection/NedostupneSection) — inak by
 * teraz Topbar-ov `<h1>` VYKRESLIL a vznikol by duplicitný nadpis.
 */
export function isVisibleTabId(id: string): boolean {
  return NAV.some((folder) => folder.tabs.some((t) => t.id === id));
}
