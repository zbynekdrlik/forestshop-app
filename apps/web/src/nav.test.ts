import { expect, it } from "vitest";
import { DEFAULT_TAB_ID, HIDDEN_TABS, NAV, findTab, isVisibleTabId } from "./nav.js";

// #57: majiteľ chce naľavo PRESNE dve viditeľné položky — tento test je
// najbližšie k tomu, čo strojovo overiť dá (registrácia, nie DOM).
it("NAV má presne dva priečinky, každý s presne jednou záložkou", () => {
  expect(NAV).toHaveLength(2);
  expect(NAV.map((f) => f.label)).toEqual(["Systém", "Eshop"]);
  for (const folder of NAV) {
    expect(folder.tabs).toHaveLength(1);
  }
  expect(NAV[0]?.tabs[0]?.label).toBe("Sync zo Shoptetu");
  expect(NAV[1]?.tabs[0]?.label).toBe("Na objednanie");
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
  for (const hiddenId of Object.keys(HIDDEN_TABS)) {
    expect(isVisibleTabId(hiddenId)).toBe(false);
  }
  expect(isVisibleTabId("neexistuje")).toBe(false);
});
