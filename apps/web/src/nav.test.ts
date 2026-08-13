import { expect, it } from "vitest";
import { DEFAULT_TAB_ID, HIDDEN_TABS, NAV, findTab, isVisibleTabId } from "./nav.js";

// #57 pôvodne chcel naľavo PRESNE dve viditeľné položky — issue 185 pridalo
// tretí priečinok "Automatizácie" s tromi hotovými obrazovkami, issue 195
// presunulo "Nedostupné tovary" z Automatizácií pod "Eshop" (nemá naplánovanú
// úlohu ani prepínač zapnuté/vypnuté, je to pracovná obrazovka), issue 192
// pridalo "Texty e-mailov" do Systému (nastavenie spoločné pre VŠETKY
// automatizácie). Issue 239 pridalo "Párovanie produktov" pod "Eshop"
// (rovnaký dôvod ako "Nedostupné tovary" — pracovná obrazovka bez plánu).
// Issue 240 pridalo "Vyhľadať" pod "Eshop" z rovnakého dôvodu. Issue 257
// pridalo "Zlúčenie objednávok" pod "Eshop" z rovnakého dôvodu (majiteľ:
// vlastná záložka, nie tlačidlo pri objednávke). Issue 267 pridalo
// "Upozornenia" pod "Eshop" z rovnakého dôvodu (pracovná obrazovka bez
// plánu/zapnuté-vypnuté konceptu). Issue 287 preusporiadalo poradie SAMOTNÝCH
// priečinkov (majiteľ: "Eshop dať uplne ako prvý... šéf ho používa
// najčastejšie") — Eshop je teraz prvý, Systém druhý, Automatizácie tretie;
// položky vnútri každého priečinka ostali nezmenené.
// Issue 290 pridalo TRI ďalšie položky ("Výmena tovaru"/"Vrátený
// tovar"/"Reklamácie") HNEĎ POD "Nedostupné tovary" (šéfovo zadanie:
// "pridať dalšie polička - pod nedostupné tovarý"). Issue 311 pridalo
// "Vypredané → Skladom: návrhy odkazov" hneď za "Vypredané → Skladom" v
// Automatizáciách (rovnaká automatizácia, doplnenie chýbajúcich odkazov,
// ktoré ju živia). Issue 292 pridalo "Preprava DPD" na koniec priečinka
// "Eshop" (majiteľovo zadanie, jedno tlačidlo na objednanie prepravy).
// Issue 342 pridalo ŠTVRTÝ priečinok "Dôležité" (PRED "Eshop"), presunulo
// "Upozornenia" doňho a pridalo novú záložku "Úlohy na dnes".
// Issue 345 pridalo "Objednávky predajňa" hneď za "Na objednanie" (obe sú
// "zoznam objednávok" obrazovky).
// Issue 387 E5 pridalo "Párovanie" hneď za "Párovanie produktov" (#239) —
// najbližší príbuzný obsah, obe zatiaľ bežia vedľa seba.
// Tento test je najbližšie k tomu, čo strojovo overiť dá (registrácia, nie DOM).
it("NAV má štyri priečinky (Dôležité/Eshop/Systém/Automatizácie), s 2/11/3/5 záložkami v poradí podľa dôležitosti", () => {
  expect(NAV).toHaveLength(4);
  expect(NAV.map((f) => f.label)).toEqual(["Dôležité", "Eshop", "Systém", "Automatizácie"]);
  expect(NAV[0]?.tabs).toHaveLength(2);
  expect(NAV[1]?.tabs).toHaveLength(11);
  expect(NAV[2]?.tabs).toHaveLength(3);
  expect(NAV[3]?.tabs).toHaveLength(5);
  expect(NAV[0]?.tabs.map((t) => t.label)).toEqual(["Upozornenia", "Úlohy na dnes"]);
  expect(NAV[1]?.tabs.map((t) => t.label)).toEqual([
    "Na objednanie",
    "Objednávky predajňa",
    "Nedostupné tovary",
    "Výmena tovaru",
    "Vrátený tovar",
    "Reklamácie",
    "Párovanie produktov",
    "Párovanie",
    "Vyhľadať",
    "Zlúčenie objednávok",
    "Preprava DPD",
  ]);
  // issue 212: "Dodávateľský sklad" — scraper dostupnosti u dodávateľa;
  // patrí do Systému (zadanie majiteľa), nie medzi Automatizácie.
  expect(NAV[2]?.tabs.map((t) => t.label)).toEqual(["Sync zo Shoptetu", "Texty e-mailov", "Dodávateľský sklad"]);
  // issue 193: "Odoslané e-maily" — prehľad toho, čo automatizácie poslali.
  expect(NAV[3]?.tabs.map((t) => t.label)).toEqual([
    // issue 213: prepínanie vypredaných produktov späť na skladom.
    "Vypredané → Skladom",
    // issue 311: návrh dodávateľského odkazu pre vypredané produkty bez neho.
    "Vypredané → Skladom: návrhy odkazov",
    "Nevyzdvihnuté zásielky",
    "Pripomienky objednávok",
    "Odoslané e-maily",
  ]);
});

// issue 343: šéf chce, aby "Systém" a "Automatizácie" štartovali v ľavom menu
// zbalené (menu inak zaberá celú výšku a treba rolovať) — "Eshop" ostáva
// rozbalený (denne používaná obrazovka). Stav je deklarovaný priamo v
// registri (`NavFolder.defaultCollapsed`), aby budúci priečinok mohol zvoliť
// vlastný predvolený stav jedným riadkom bez zásahu do `Sidebar.tsx` (viď
// jeho vlastný test). Issue 342: "Dôležité" (nový, PRVÝ priečinok) ostáva
// tiež rozbalený — rovnaký dôvod ako "Eshop" (dennodenne používaná
// obrazovka).
it("Dôležité a Eshop nemajú defaultCollapsed nastavené, Systém a Automatizácie majú true", () => {
  expect(NAV[0]?.label).toBe("Dôležité");
  expect(NAV[0]?.defaultCollapsed).toBeUndefined();
  expect(NAV[1]?.label).toBe("Eshop");
  expect(NAV[1]?.defaultCollapsed).toBeUndefined();
  expect(NAV[2]?.label).toBe("Systém");
  expect(NAV[2]?.defaultCollapsed).toBe(true);
  expect(NAV[3]?.label).toBe("Automatizácie");
  expect(NAV[3]?.defaultCollapsed).toBe(true);
});

// issue 287: DEFAULT_TAB_ID sa NEODVODZUJE od NAV[0] (to je "eshop", priečinok,
// nie záložka) — je to PEVNÝ literál, nezávislý od poradia priečinkov v NAV.
// issue 302 (šéf, cez Discord): "keď štartnem appku, nešlo by to na Na
// objednanie namiesto Sync zo Shoptetu?" — literál sa zmenil zo "sync" na
// "orders", priame odkazy na ostatné obrazovky (`?tab=<id>`) sa nedotkli.
it("DEFAULT_TAB_ID je pevne 'orders' — nezávisí od poradia priečinkov v NAV", () => {
  expect(DEFAULT_TAB_ID).toBe("orders");
});

it("findTab nájde viditeľnú aj skrytú záložku podľa id, neznáme id vráti undefined", () => {
  expect(findTab("sync")?.label).toBe("Sync zo Shoptetu");
  expect(findTab("orders")?.label).toBe("Na objednanie");
  expect(findTab("catalog")?.label).toBe("Katalóg");
  expect(findTab("pairing")?.label).toBe("Kontrola párovania");
  expect(findTab("scheduler")?.label).toBe("Plánovač");
  expect(findTab("posta-uncollected")?.label).toBe("Nevyzdvihnuté zásielky");
  expect(findTab("order-reminder")?.label).toBe("Pripomienky objednávok");
  expect(findTab("search")?.label).toBe("Vyhľadať");
  expect(findTab("exchange")?.label).toBe("Výmena tovaru");
  expect(findTab("returned")?.label).toBe("Vrátený tovar");
  expect(findTab("claims")?.label).toBe("Reklamácie");
  expect(findTab("restock-links")?.label).toBe("Vypredané → Skladom: návrhy odkazov");
  expect(findTab("pairing-review")?.label).toBe("Párovanie");
  expect(findTab("upozornenia")?.label).toBe("Upozornenia");
  expect(findTab("ulohy")?.label).toBe("Úlohy na dnes");
  expect(findTab("neexistuje")).toBeUndefined();
});

it("isVisibleTabId rozlíši viditeľné (NAV) od skrytých (HIDDEN_TABS)", () => {
  expect(isVisibleTabId("sync")).toBe(true);
  expect(isVisibleTabId("orders")).toBe(true);
  // issue 185: presunuté z HIDDEN_TABS do NAV — teraz viditeľné.
  expect(isVisibleTabId("posta-uncollected")).toBe(true);
  expect(isVisibleTabId("order-reminder")).toBe(true);
  expect(isVisibleTabId("nedostupne")).toBe(true);
  // issue 240: nová viditeľná záložka "Vyhľadať".
  expect(isVisibleTabId("search")).toBe(true);
  // issue 290: tri nové viditeľné záložky pod "Nedostupné tovary".
  expect(isVisibleTabId("exchange")).toBe(true);
  expect(isVisibleTabId("returned")).toBe(true);
  expect(isVisibleTabId("claims")).toBe(true);
  // issue 311: nová viditeľná záložka "Vypredané → Skladom: návrhy odkazov".
  expect(isVisibleTabId("restock-links")).toBe(true);
  // issue 387 E5: nová viditeľná záložka "Párovanie".
  expect(isVisibleTabId("pairing-review")).toBe(true);
  // issue 342: nová viditeľná záložka "Úlohy na dnes" (v priečinku "Dôležité").
  expect(isVisibleTabId("ulohy")).toBe(true);
  for (const hiddenId of Object.keys(HIDDEN_TABS)) {
    expect(isVisibleTabId(hiddenId)).toBe(false);
  }
  expect(HIDDEN_TABS).not.toHaveProperty("posta-uncollected");
  expect(HIDDEN_TABS).not.toHaveProperty("order-reminder");
  expect(HIDDEN_TABS).not.toHaveProperty("nedostupne");
  expect(isVisibleTabId("neexistuje")).toBe(false);
});
