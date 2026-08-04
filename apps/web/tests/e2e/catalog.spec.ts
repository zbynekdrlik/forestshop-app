import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze

// `GET /api/me` s odpoveďou 401 hneď po otvorení stránky. Rozpoznáva sa podľa
// `location().url`, nie podľa textu — Chromium URL do textu „Failed to load
// resource" nedáva. Rozširovanie výnimky na ďalšie cesty je zakázané.

// #57: "Katalóg" je od nového ľavého menu SKRYTÁ obrazovka (viditeľné sú len
// "Sync zo Shoptetu"/"Na objednanie") — kód aj testy ostávajú, dostupná ďalej
// cez priamy odkaz `?tab=catalog` (`nav.ts`'s HIDDEN_TABS).

test("manažér vidí stav katalógu, vyhľadá variant a konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=catalog");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // 40 = 35 riadkov fixtúry + 2 seedované kandidáty na prepnutie ("PREP-1",
  // issue 217; "PREP-2", issue 226 — rozpor voči feedu, `scripts/e2e-setup.ts`)
  // + 2 seedované produkty pre "Párovanie produktov" ("E2E-PL-CHYBA"/
  // "E2E-PL-OPRAVA", issue 239, `scripts/e2e-fixtures-product-links.ts`)
  // + 1 seedovaný produkt pre "Vyhľadať" ("E2E-SEARCH-1", issue 240,
  // `scripts/e2e-fixtures-search.ts`).
  // Prví dvaja sú `out_of_stock` (nemenia "sellable"/"missing" nižšie), zvyšní
  // traja sú `sellable` (posúvajú filter "sellable" 7→10 nižšie), "missing"(1)
  // sa nemení ani jedným z nich.
  await expect(page.getByTestId("snapshot")).toContainText("Posledný import: prijatý");
  await expect(page.getByTestId("counts")).toContainText("Variantov v katalógu (vrátane chýbajúcich): 40");
  await expect(page.getByTestId("total")).toHaveText("Nájdených: 40");

  await page.getByLabel("Kód alebo názov").fill("40237/3XL");
  await page.getByRole("button", { name: "Hľadať", exact: true }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 1");
  const riadok = page.getByTestId("variant-40237/3XL");
  await expect(riadok).toContainText("Nohavice FOREST 1003");
  await expect(riadok).toContainText("Predaj skončil");
  await expect(riadok).toContainText("62.76 EUR");

  expect(chyby).toEqual([]);
});

test("filter podľa stavu zúži zoznam na predajné varianty", async ({ page }) => {
  await page.goto("/?tab=catalog");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 40");
  await page.getByLabel("Stav", { exact: true }).selectOption("sellable");
  await page.getByRole("button", { name: "Hľadať", exact: true }).click();

  // 10 = 7 od issue 219 (variant "40237/L" má oba texty dostupnosti prázdne,
  // čo znamená predvolenú dostupnosť Shoptetu — "Skladom", nie vypredané) +
  // 2 sellable produkty issue 239's fixtúry ("E2E-PL-CHYBA"/"E2E-PL-OPRAVA")
  // + 1 sellable produkt issue 240's fixtúry ("E2E-SEARCH-1").
  await expect(page.getByTestId("total")).toHaveText("Nájdených: 10");
  await expect(page.getByTestId("variant-40237/M")).toBeVisible();
});

// Review final-wave-a, položka 6: `scripts/e2e-setup.ts` označí variant
// "40287" priamo v databáze ako chýbajúci (presne jeden zo 7 "sellable").
test("filter 'Chýbajúce' nájde presne označený variant a riadok ukazuje, odkedy chýba", async ({ page }) => {
  await page.goto("/?tab=catalog");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 40");
  await page.getByLabel("Stav", { exact: true }).selectOption("missing");
  await page.getByRole("button", { name: "Hľadať", exact: true }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 1");
  const riadok = page.getByTestId("variant-40287");
  await expect(riadok).toBeVisible();
  await expect(riadok).toContainText("chýba od");
});
