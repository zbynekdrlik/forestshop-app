import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// Vlastný, IZOLOVANÝ účet len pre tento súbor (rovnaký dôvod aj mechanizmus
// ako `E2E_NAV_EMAIL`/`E2E_PAROVANIE_EMAIL`) — musí sa zhodovať s hodnotou
// `E2E_VYHLADAT_EMAIL` v `scripts/e2e-fixtures-search.ts`.
const E2E_VYHLADAT_EMAIL = "e2e-vyhladat@forestshop.sk";

// issue 289: "Eshop → Vyhľadať" — DVE nezávislé, popísané polia namiesto
// jedného spoločného (issue 240): "Produkt" (nájsť podľa kódu/názvu, otvoriť
// detail, zmeniť dodávateľskú linku) a "Objednávka" (nájsť podľa čísla,
// klik vedie do detailu objednávky v Shoptete). Obe polia fungujú
// NEZÁVISLE — písanie do jedného nemaže výsledok druhého.
test("Produkt a Objednávka sú dve nezávislé polia — nájde produkt aj objednávku, oboje prežije prechod do detailu, konzola je čistá", async ({
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

  // Obe polia sú viditeľné a POPÍSANÉ hneď od začiatku, ešte pred hľadaním.
  await expect(page.getByLabel("Produkt")).toBeVisible();
  await expect(page.getByLabel("Objednávka")).toBeVisible();

  // Hľadanie OBJEDNÁVKY podľa čísla — najprv, aby sa overilo, že produktové
  // pole zostáva prázdne (polia sa navzájom neovplyvňujú).
  await page.getByLabel("Objednávka").fill("9101");
  await page.getByRole("button", { name: "Hľadať objednávku" }).click();
  const objednavkaRiadok = page.getByTestId("search-order-9101");
  await expect(objednavkaRiadok).toBeVisible();
  await expect(objednavkaRiadok).toContainText("E2E Zákazník Vyhľadávanie");
  await expect(page.getByTestId("search-products")).toHaveCount(0);

  // Hľadanie PRODUKTU podľa PRESNÉHO kódu variantu — objednávkový výsledok
  // z predošlého kroku ostáva netknutý (nezávislé polia).
  await page.getByLabel("Produkt").fill("E2E-SEARCH-1");
  await page.getByRole("button", { name: "Hľadať produkt" }).click();

  const produktRiadok = page.getByTestId("search-product-E2E-SEARCH-1");
  await expect(produktRiadok).toBeVisible();
  await expect(produktRiadok).toContainText("E2E Vyhľadávací Produkt Alfa");
  await expect(produktRiadok).toContainText("E2E Dodávateľ Vyhľadávanie");
  // Objednávkový výsledok z predošlého hľadania stále stojí.
  await expect(objednavkaRiadok).toBeVisible();

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

  // Pole "Objednávka" je namontované AJ počas detailu produktu (nezávislé
  // od navigácie v produktovom poli) — jeho predošlý výsledok tu stále je.
  await expect(page.getByTestId("search-order-9101")).toBeVisible();

  // Späť na hľadanie a nájsť produkt podľa ČASTI názvu — objednávkový
  // výsledok stále stojí, nikdy nebol vymazaný.
  await page.getByTestId("search-back").click();
  await expect(page.getByTestId("search-section")).toBeVisible();
  await expect(page.getByTestId("search-order-9101")).toBeVisible();

  await page.getByLabel("Produkt").fill("Vyhľadávací Produkt");
  await page.getByRole("button", { name: "Hľadať produkt" }).click();
  await expect(page.getByTestId("search-product-E2E-SEARCH-1")).toBeVisible();

  // Neexistujúce číslo objednávky zobrazí jasnú hlášku "nič sa nenašlo",
  // nie ticho prázdny blok.
  await page.getByLabel("Objednávka").fill("99999999");
  await page.getByRole("button", { name: "Hľadať objednávku" }).click();
  await expect(page.getByTestId("search-order-empty")).toBeVisible();
  await expect(page.getByTestId("search-orders")).toHaveCount(0);
  // Produktové pole tým nebolo ovplyvnené.
  await expect(page.getByTestId("search-product-E2E-SEARCH-1")).toBeVisible();

  // Nič-nezodpovedajúci dopyt na produkt zobrazí rovnaký druh hlášky.
  await page.getByLabel("Produkt").fill("nieco-co-nikde-nie-je");
  await page.getByRole("button", { name: "Hľadať produkt" }).click();
  await expect(page.getByTestId("search-product-empty")).toBeVisible();
  await expect(page.getByTestId("search-products")).toHaveCount(0);

  expect(chyby).toEqual([]);
});
