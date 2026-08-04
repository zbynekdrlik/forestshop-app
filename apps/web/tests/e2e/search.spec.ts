import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// Vlastný, IZOLOVANÝ účet len pre tento súbor (rovnaký dôvod aj mechanizmus
// ako `E2E_NAV_EMAIL`/`E2E_PAROVANIE_EMAIL`) — musí sa zhodovať s hodnotou
// `E2E_VYHLADAT_EMAIL` v `scripts/e2e-fixtures-search.ts`.
const E2E_VYHLADAT_EMAIL = "e2e-vyhladat@forestshop.sk";

// issue 240: "Eshop → Vyhľadať" — nájsť produkt podľa kódu aj názvu a
// objednávku podľa čísla, otvoriť detail produktu, zmeniť dodávateľskú
// linku, uložiť a vidieť stav.
test("nájde produkt podľa kódu, otvorí detail, zmení a uloží dodávateľskú linku so stavom, konzola je čistá", async ({
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
  await page.getByLabel("E-mail").fill(E2E_VYHLADAT_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await page.getByRole("button", { name: "Vyhľadať" }).click();
  await expect(page.getByRole("heading", { name: "Vyhľadať" })).toBeVisible();

  // Hľadanie podľa PRESNÉHO kódu variantu.
  await page.getByLabel("Hľadať").fill("E2E-SEARCH-1");
  await page.getByRole("button", { name: "Hľadať", exact: true }).click();

  const produktRiadok = page.getByTestId("search-product-E2E-SEARCH-1");
  await expect(produktRiadok).toBeVisible();
  await expect(produktRiadok).toContainText("E2E Vyhľadávací Produkt Alfa");
  await expect(produktRiadok).toContainText("E2E Dodávateľ Vyhľadávanie");
  // Objednávky sa nenašli pre tento dopyt — žiadny blok "Objednávky".
  await expect(page.getByTestId("search-orders")).toHaveCount(0);

  await page.getByTestId("search-product-open-E2E-SEARCH-1").click();

  await expect(page.getByTestId("search-detail-name")).toHaveText("E2E Vyhľadávací Produkt Alfa");
  await expect(page.getByTestId("search-detail-supplier")).toContainText("E2E Dodávateľ Vyhľadávanie");

  const variantRiadok = page.getByTestId("search-detail-variant-E2E-SEARCH-1");
  await expect(variantRiadok).toContainText("24.90");
  await expect(variantRiadok).toContainText("EXT-VYHLADAT-1");
  await expect(variantRiadok).toContainText("Skladom (Skladom)");
  await expect(page.getByTestId("search-detail-supplier-stock-E2E-SEARCH-1")).toContainText(
    "Skladom u e2e dodávateľa",
  );
  await expect(page.getByTestId("search-detail-shop-link-E2E-SEARCH-1")).toHaveAttribute(
    "href",
    "https://www.forestshop.sk/e2e-vyhladat-produkt/",
  );

  // Efektívna linka pred úpravou pochádza z internalNote (žiadny override
  // ešte neexistuje) — vidno ju priamo, dá sa upraviť.
  await expect(page.getByTestId("search-detail-link-value")).toContainText(
    "https://e2e-dodavatel.example.com/vyhladat-produkt",
  );
  await expect(page.getByTestId("search-detail-link-status")).toHaveText("zo Shoptetu");

  await page.getByTestId("search-detail-link-edit-toggle").click();
  const linkInput = page.getByTestId("search-detail-link-edit-input");
  await expect(linkInput).toHaveValue("https://e2e-dodavatel.example.com/vyhladat-produkt");
  await linkInput.fill("https://e2e-dodavatel.example.com/vyhladat-produkt-novy");
  await page.getByTestId("search-detail-link-save").click();

  await expect(page.getByTestId("search-detail-link-value")).toHaveText(
    "https://e2e-dodavatel.example.com/vyhladat-produkt-novy",
  );
  await expect(page.getByTestId("search-detail-link-status")).toContainText("čaká na odoslanie");

  // Späť na hľadanie a nájsť objednávku podľa čísla.
  await page.getByTestId("search-back").click();
  await expect(page.getByTestId("search-section")).toBeVisible();

  await page.getByLabel("Hľadať").fill("9101");
  await page.getByRole("button", { name: "Hľadať", exact: true }).click();
  const objednavkaRiadok = page.getByTestId("search-order-9101");
  await expect(objednavkaRiadok).toBeVisible();
  await expect(objednavkaRiadok).toContainText("E2E Zákazník Vyhľadávanie");
  await expect(page.getByTestId("search-products")).toHaveCount(0);

  // Hľadanie podľa ČASTI názvu produktu tiež nájde ten istý produkt.
  await page.getByLabel("Hľadať").fill("Vyhľadávací Produkt");
  await page.getByRole("button", { name: "Hľadať", exact: true }).click();
  await expect(page.getByTestId("search-product-E2E-SEARCH-1")).toBeVisible();

  expect(chyby).toEqual([]);
});
