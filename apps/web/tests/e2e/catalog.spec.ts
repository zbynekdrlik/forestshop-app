import { expect, test, type ConsoleMessage } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze

// Rovnaká a JEDINÁ povolená výnimka ako v login.spec.ts: neautentifikovaný
// `GET /api/me` s odpoveďou 401 hneď po otvorení stránky. Rozpoznáva sa podľa
// `location().url`, nie podľa textu — Chromium URL do textu „Failed to load
// resource" nedáva. Rozširovanie výnimky na ďalšie cesty je zakázané.
const jeOcakavane = (m: ConsoleMessage): boolean =>
  m.location().url.includes("/api/me") && m.text().includes("401");

test("manažér vidí stav katalógu, vyhľadá variant a konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByTestId("snapshot")).toContainText("Posledný import: prijatý");
  await expect(page.getByTestId("counts")).toContainText("Variantov: 35");
  await expect(page.getByTestId("total")).toHaveText("Nájdených: 35");

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
  await page.goto("/");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 35");
  await page.getByLabel("Stav").selectOption("sellable");
  await page.getByRole("button", { name: "Hľadať" }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 6");
  await expect(page.getByTestId("variant-40237/M")).toBeVisible();
});

// Review final-wave-a, položka 6: `scripts/e2e-setup.ts` označí variant
// "40287" priamo v databáze ako chýbajúci (presne jeden zo 6 "sellable").
test("filter 'Chýbajúce' nájde presne označený variant a riadok ukazuje, odkedy chýba", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 35");
  await page.getByLabel("Stav").selectOption("missing");
  await page.getByRole("button", { name: "Hľadať" }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 1");
  const riadok = page.getByTestId("variant-40287");
  await expect(riadok).toBeVisible();
  await expect(riadok).toContainText("chýba od");
});
