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

  // 36 = 35 riadkov fixtúry + 1 seedovaný kandidát na prepnutie ("PREP-1",
  // issue 217, `scripts/e2e-setup.ts`). Je v stave `out_of_stock`, takže
  // filtre "sellable"(7 od issue 219) a "missing"(1) nižšie sa ním nemenia.
  await expect(page.getByTestId("snapshot")).toContainText("Posledný import: prijatý");
  await expect(page.getByTestId("counts")).toContainText("Variantov v katalógu (vrátane chýbajúcich): 36");
  await expect(page.getByTestId("total")).toHaveText("Nájdených: 36");

  await page.getByLabel("Kód alebo názov").fill("40237/3XL");
  await page.getByRole("button", { name: "Hľadať" }).click();

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

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 36");
  await page.getByLabel("Stav", { exact: true }).selectOption("sellable");
  await page.getByRole("button", { name: "Hľadať" }).click();

  // 7 od issue 219: variant "40237/L" má oba texty dostupnosti prázdne, čo
  // znamená predvolenú dostupnosť Shoptetu (na tomto e-shope "Skladom"), nie
  // vypredané — preto sa počíta medzi predajné.
  await expect(page.getByTestId("total")).toHaveText("Nájdených: 7");
  await expect(page.getByTestId("variant-40237/M")).toBeVisible();
});

// Review final-wave-a, položka 6: `scripts/e2e-setup.ts` označí variant
// "40287" priamo v databáze ako chýbajúci (presne jeden zo 7 "sellable").
test("filter 'Chýbajúce' nájde presne označený variant a riadok ukazuje, odkedy chýba", async ({ page }) => {
  await page.goto("/?tab=catalog");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 36");
  await page.getByLabel("Stav", { exact: true }).selectOption("missing");
  await page.getByRole("button", { name: "Hľadať" }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 1");
  const riadok = page.getByTestId("variant-40287");
  await expect(riadok).toBeVisible();
  await expect(riadok).toContainText("chýba od");
});
