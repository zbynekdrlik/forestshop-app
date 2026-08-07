import type { ComponentType } from "react";
import type { Me } from "./api.js";
import { CatalogPage } from "./components/CatalogPage.js";
import { ClaimOrdersSection } from "./components/ClaimOrdersSection.js";
import { ExchangeOrdersSection } from "./components/ExchangeOrdersSection.js";
import { MailLogSection } from "./components/MailLogSection.js";
import { MailTemplatesSection } from "./components/MailTemplatesSection.js";
import { NedostupneSection } from "./components/NedostupneSection.js";
import { OrderMergeSection } from "./components/OrderMergeSection.js";
import { OrderReminderSection } from "./components/OrderReminderSection.js";
import { OrdersSection } from "./components/OrdersSection.js";
import { PairingSection } from "./components/PairingSection.js";
import { PostaUncollectedSection } from "./components/PostaUncollectedSection.js";
import { RestockSection } from "./components/RestockSection.js";
import { ReturnedOrdersSection } from "./components/ReturnedOrdersSection.js";
import { SchedulerSection } from "./components/SchedulerSection.js";
import { SearchSection } from "./components/SearchSection.js";
import { SupplierLinksSection } from "./components/SupplierLinksSection.js";
import { SupplierStockSection } from "./components/SupplierStockSection.js";
import { SyncSection } from "./components/SyncSection.js";
import { UpozorneniaSection } from "./components/UpozorneniaSection.js";

// Spoločný tvar props pre KAŽDÚ obrazovku registrovanú tu — presne to, čo dnes
// prijíma CatalogPage/OrdersSection/PairingSection/SchedulerSection/SyncSection.
export interface SectionProps {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}

export interface NavTab {
  readonly id: string;
  readonly label: string;
  // issue 190: ikona pre ZBALENÝ bočný panel — v tom stave je to JEDINÉ, čo z
  // položky vidno, takže musí byť na prvý pohľad rozlíšiteľná od ostatných
  // (názov sa ukáže až po prejdení myšou, `Sidebar.tsx`'s `title`/`aria-label`).
  // Povinná, aby nová záložka nemohla vzniknúť bez ikony a v zbalenom paneli
  // ostať neviditeľná.
  readonly icon: string;
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
    id: "eshop",
    label: "Eshop",
    // issue 287: majiteľ, "adresár Eshop dať uplne ako prvý... Eshop je to,
    // čo šéf používa najčastejšie, tak nech je hore" — priečinok je preto
    // PRVÝ v poli (poradie prvkov = poradie vykreslenia, `Sidebar.tsx`
    // neprida žiadne vlastné triedenie). Položky vnútri ostávajú nezmenené.
    //
    // issue 195: "Nedostupné tovary" patrí SEM, nie medzi Automatizácie —
    // nemá naplánovanú úlohu ani prepínač zapnuté/vypnuté, je to obrazovka,
    // na ktorej obsluha pracuje, presne ako "Na objednanie". `wide: true` pri
    // oboch z rovnakého dôvodu (hustý pracovný obsah profituje z celej šírky
    // okna, viď `NavTab.wide` vyššie).
    tabs: [
      { id: "orders", label: "Na objednanie", icon: "📦", Component: OrdersSection, wide: true },
      { id: "nedostupne", label: "Nedostupné tovary", icon: "🚫", Component: NedostupneSection, wide: true },
      // issue 290: šéfovo zadanie (Discord, 6.8.2026) — tri nové položky
      // "hneď pod Nedostupné tovary". READ-ONLY pohľady nad `order.status_
      // name` (Výmena/Vrátený tovar) + appkina vlastná reklamácia-značka
      // (Reklamácie) — žiadna z nich nezakladá novú kartu na Upozorneniach,
      // rozhodnuté na tickete (`.claude/rules/upozornenia.md`,
      // `order-flags.ts`).
      { id: "exchange", label: "Výmena tovaru", icon: "🔃", Component: ExchangeOrdersSection, wide: true },
      { id: "returned", label: "Vrátený tovar", icon: "↩️", Component: ReturnedOrdersSection, wide: true },
      { id: "claims", label: "Reklamácie", icon: "⚠️", Component: ClaimOrdersSection, wide: true },
      // issue 239: majiteľ, "vypisovat produkty ktore nemaju dodavatelsku
      // linku, dat moznost ju tam rovno vlozit, a poslat do Shoptetu" — patrí
      // sem (nie do Automatizácie), je to obrazovka, na ktorej obsluha
      // pracuje, presne ako "Na objednanie"/"Nedostupné tovary".
      { id: "supplier-links", label: "Párovanie produktov", icon: "🔗", Component: SupplierLinksSection, wide: true },
      // issue 240: "rýchla ruka" na JEDEN konkrétny kus tovaru/objednávku —
      // nájsť + rovno opraviť dodávateľskú linku. Patrí sem z rovnakého
      // dôvodu ako "Párovanie produktov" vyššie (obsluha na nej pracuje,
      // žiadny plán/zapnuté-vypnuté koncept).
      { id: "search", label: "Vyhľadať", icon: "🔍", Component: SearchSection, wide: true },
      // issue 257: majiteľ, "malo by to byt zalozka v eshope a mali by tam
      // vyskocit ak su dve objedanvky na toho isteho zakaznika" — patrí sem
      // z rovnakého dôvodu ako "Párovanie produktov"/"Vyhľadať" vyššie
      // (obsluha na nej pracuje, žiadny plán/zapnuté-vypnuté koncept).
      { id: "order-merge", label: "Zlúčenie objednávok", icon: "🔀", Component: OrderMergeSection, wide: true },
      // issue 267: "Upozornenia" — nástenka vecí, ktoré majiteľ musí vybaviť
      // (vlastné poznámky + budúce automatické zdroje #268/#269). Patrí sem
      // (nie do Automatizácie) z rovnakého dôvodu ako "Na objednanie" —
      // obsluha na nej pracuje, žiadny plán/zapnuté-vypnuté koncept.
      { id: "upozornenia", label: "Upozornenia", icon: "🔔", Component: UpozorneniaSection, wide: true },
    ],
  },
  {
    id: "system",
    label: "Systém",
    // issue 192: "Texty e-mailov" patrí sem — je to nastavenie appky, ktoré sa
    // dotýka VŠETKÝCH automatizácií naraz, nie práca s konkrétnymi
    // objednávkami (tá je v Eshope) ani jedna konkrétna automatizácia.
    tabs: [
      { id: "sync", label: "Sync zo Shoptetu", icon: "🔄", Component: SyncSection },
      { id: "mail-templates", label: "Texty e-mailov", icon: "✉️", Component: MailTemplatesSection, wide: true },
      // issue 212: scraper dostupnosti u dodávateľa — patrí do Systému
      // (majiteľ: "scrapera ktoreho chcem v zalozke system"), nie medzi
      // Automatizácie: nič neprepína, len zbiera údaje pre issue 213.
      { id: "supplier-stock", label: "Dodávateľský sklad", icon: "🏭", Component: SupplierStockSection, wide: true },
    ],
  },
  {
    id: "automations",
    label: "Automatizácie",
    // Len tie dve veci, ktoré SKUTOČNE bežia na plán a dajú sa zapnúť/vypnúť
    // (issue 195). Poradie podľa dôležitosti (issue 185, zadanie majiteľa).
    // issue 193: "Odoslané e-maily" patrí SEM — je to prehľad toho, čo
    // automatizácie poslali (majiteľ: "v automatizaciach dufam su vsetky
    // potrebne statistiky komu sa poslal mail"). `wide: true` ako pri
    // ostatných hustých pracovných tabuľkách.
    tabs: [
      // issue 213: automatické zapínanie vypredaných produktov, ktoré
      // dodávateľ zase má skladom — beží na plán a má Štart/Stop, takže
      // patrí sem, nie do Systému (tam je len scraper, ktorý nič neprepína).
      { id: "restock", label: "Vypredané → Skladom", icon: "🔁", Component: RestockSection, wide: true },
      { id: "posta-uncollected", label: "Nevyzdvihnuté zásielky", icon: "📮", Component: PostaUncollectedSection },
      { id: "order-reminder", label: "Pripomienky objednávok", icon: "⏰", Component: OrderReminderSection },
      { id: "mail-log", label: "Odoslané e-maily", icon: "📨", Component: MailLogSection, wide: true },
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
  // Ikony sú tu len kvôli spoločnému typu `NavTab` — skryté obrazovky sa v
  // ľavom menu (ani v jeho zbalenom stave) nikdy nevykreslia.
  catalog: { id: "catalog", label: "Katalóg", icon: "📚", Component: CatalogPage },
  pairing: { id: "pairing", label: "Kontrola párovania", icon: "🔗", Component: PairingSection },
  scheduler: { id: "scheduler", label: "Plánovač", icon: "🗓️", Component: SchedulerSection },
};

// issue 287: `DEFAULT_TAB_ID` sa NEODVODZUJE od `NAV[0]` (to je priečinok
// "eshop", nie záložka) — je to pevný literál, nezávislý od poradia
// priečinkov v menu, aby prípadné budúce preusporiadanie `NAV` nikdy ticho
// nezmenilo landing obrazovku.
//
// issue 302 (šéf, cez Discord, 7. 8. 2026): "keď štartnem appku — nešlo by
// to do tejto obrazovky (Sync zo Shoptetu) — ale to na objednanie?" — po
// prihlásení appka predtým otvárala "Sync zo Shoptetu", šéf s ňou reálne
// nepracuje. Literál sa preto zmenil zo "sync" na "orders" — priame odkazy
// na OSTATNÉ obrazovky (`?tab=<id>`, vrátane `HIDDEN_TABS`) sa touto zmenou
// vôbec nedotknú, mení sa len to, kam appka ide, keď žiadna obrazovka nie
// je v URL určená (`App.tsx`'s `initialTabId`).
export const DEFAULT_TAB_ID: string = "orders";

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
