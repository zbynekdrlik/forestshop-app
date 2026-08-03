import { expect, it } from "vitest";
import { DEFAULT_TAB_ID, HIDDEN_TABS, NAV, findTab, isVisibleTabId } from "./nav.js";

// #57 pôvodne chcel naľavo PRESNE dve viditeľné položky — issue 185 pridalo
// tretí priečinok "Automatizácie" s tromi hotovými obrazovkami, issue 195
// presunulo "Nedostupné tovary" z Automatizácií pod "Eshop" (nemá naplánovanú
// úlohu ani prepínač zapnuté/vypnuté, je to pracovná obrazovka). Tento test je
// najbližšie k tomu, čo strojovo overiť dá (registrácia, nie DOM).
it("NAV má tri priečinky (Systém/Eshop/Automatizácie), s 1/2/2 záložkami v poradí podľa dôležitosti", () => {
  expect(NAV).toHaveLength(3);
  expect(NAV.map((f) => f.label)).toEqual(["Systém", "Eshop", "Automatizácie"]);
  expect(NAV[0]?.tabs).toHaveLength(1);
  expect(NAV[1]?.tabs).toHaveLength(2);
  expect(NAV[2]?.tabs).toHaveLength(2);
  expect(NAV[0]?.tabs[0]?.label).toBe("Sync zo Shoptetu");
  expect(NAV[1]?.tabs.map((t) => t.label)).toEqual(["Na objednanie", "Nedostupné tovary"]);
  expect(NAV[2]?.tabs.map((t) => t.label)).toEqual([
    "Nevyzdvihnuté zásielky",
    "Pripomienky objednávok",
  ]);
});

it("DEFAULT_TAB_ID je prvá viditeľná záložka ('sync')", () => {
  expect(DEFAULT_TAB_ID).toBe("sync");
});

it("findTab nájde viditeľnú aj skrytú záložku podľa id, neznáme id vráti undefined", () => {
  expect(findTab("sync")?.label).toBe("Sync zo Shoptetu");
  expect(findTab("orders")?.label).toBe("Na objednanie");
  expect(findTab("catalog")?.label).toBe("Katalóg");
  expect(findTab("pairing")?.label).toBe("Kontrola párovania");
  expect(findTab("scheduler")?.label).toBe("Plánovač");
  expect(findTab("posta-uncollected")?.label).toBe("Nevyzdvihnuté zásielky");
  expect(findTab("order-reminder")?.label).toBe("Pripomienky objednávok");
  expect(findTab("neexistuje")).toBeUndefined();
});

it("isVisibleTabId rozlíši viditeľné (NAV) od skrytých (HIDDEN_TABS)", () => {
  expect(isVisibleTabId("sync")).toBe(true);
  expect(isVisibleTabId("orders")).toBe(true);
  // issue 185: presunuté z HIDDEN_TABS do NAV — teraz viditeľné.
  expect(isVisibleTabId("posta-uncollected")).toBe(true);
  expect(isVisibleTabId("order-reminder")).toBe(true);
  expect(isVisibleTabId("nedostupne")).toBe(true);
  for (const hiddenId of Object.keys(HIDDEN_TABS)) {
    expect(isVisibleTabId(hiddenId)).toBe(false);
  }
  expect(HIDDEN_TABS).not.toHaveProperty("posta-uncollected");
  expect(HIDDEN_TABS).not.toHaveProperty("order-reminder");
  expect(HIDDEN_TABS).not.toHaveProperty("nedostupne");
  expect(isVisibleTabId("neexistuje")).toBe(false);
});
