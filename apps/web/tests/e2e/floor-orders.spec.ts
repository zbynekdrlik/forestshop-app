import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_OBJEDNAVKY_PREDAJNA_EMAIL = "e2e-predajna@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-fixtures-floor-orders.ts

// issue 345: "Eshop → Objednávky predajňa" — nová viditeľná záložka
// (`nav.ts`, priečinok Eshop, hneď za "Na objednanie"). Fixtúrové
// objednávky "93001"–"93011" (11 kusov, PAGE_SIZE + 1 = 10 + 1) + "93999"
// (INÁ doprava, nesmie sa nikdy objaviť) patria VÝHRADNE tomuto spec
// súboru (`scripts/e2e-fixtures-floor-orders.ts`).
test("zobrazí objednávky predajne najnovšie hore, odkaz do Shoptetu funguje, Načítať ďalšie odhalí zvyšok; konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_OBJEDNAVKY_PREDAJNA_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  await page.getByRole("button", { name: "Objednávky predajňa" }).click();
  await expect(page.getByRole("heading", { name: "Objednávky predajňa" })).toBeVisible();

  // Nájdených: 11 (fixtúra), zobrazených prvých 10 (PAGE_SIZE) — dôkaz, že
  // stránkovanie/total naozaj funguje pred akýmkoľvek klikom.
  await expect(page.getByTestId("floor-orders-total")).toHaveText("Nájdených: 11 (zobrazených prvých 10)");

  // Najnovšia (93011, i=11 → najneskorší dátum vo fixtúre) je PRVÁ.
  const riadky = page.locator('[data-testid^="floor-order-row-"]');
  await expect(riadky.first()).toHaveAttribute("data-testid", "floor-order-row-93011");

  const riadok = page.getByTestId("floor-order-row-93011");
  await expect(riadok).toContainText("E2E Zákazník Predajňa 11");
  await expect(riadok).toContainText("21.00 €");

  // Iná doprava (93999, "Kuriér") sa nesmie nikdy objaviť.
  await expect(page.getByTestId("floor-order-row-93999")).toHaveCount(0);

  // Odkaz do Shoptet administrácie nesie číslo objednávky.
  await expect(page.getByTestId("floor-order-admin-link-93011")).toHaveAttribute("href", /93011/);

  // Najstaršia (93001) je zatiaľ MIMO prvej strany.
  await expect(page.getByTestId("floor-order-row-93001")).toHaveCount(0);

  await page.getByTestId("load-more").click();
  await expect(page.getByTestId("floor-orders-total")).toHaveText("Nájdených: 11");
  await expect(page.getByTestId("floor-order-row-93001")).toBeVisible();

  expect(chyby).toEqual([]);
});
