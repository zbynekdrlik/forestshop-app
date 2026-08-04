import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// VLASTNÝ izolovaný účet (rovnaký mechanizmus ako `E2E_PREHLAD_EMAIL`/ostatné,
// `.claude/rules/frontend-design.md`) — zdieľaný `e2e@forestshop.sk` je už na
// hranici `MAX_ATTEMPTS`. Musí sa zhodovať s `scripts/e2e-fixtures-product-
// links.ts`'s `E2E_PAROVANIE_EMAIL`.
const E2E_PAROVANIE_EMAIL = "e2e-parovanie@forestshop.sk";

// issue 239: "Eshop → Párovanie produktov" — VIDITEĽNÁ záložka (`nav.ts`,
// skupina Eshop). Fixtúry (`scripts/e2e-fixtures-product-links.ts`): produkt
// "E2E-PL-CHYBA" (žiadny `internalNote`, žiadny override — "doplniť" cesta)
// a "E2E-PL-OPRAVA" (už uložený, ešte NEODOSLANÝ override — "opraviť" cesta).

test("produkt bez linky ponúka 'Doplniť', po uložení sa presunie do 'S linkou' a stav ukazuje čaká na odoslanie; existujúca linka sa dá opraviť, konzola je čistá", async ({
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
  await page.getByLabel("E-mail").fill(E2E_PAROVANIE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await page.getByRole("button", { name: "Párovanie produktov" }).click();
  await expect(page.getByRole("heading", { name: "Párovanie produktov" })).toBeVisible();

  // Predvolený filter je "Bez linky" — fixtúra "E2E-PL-CHYBA" sa tam nájde.
  await page.getByLabel("Hľadať produkt (kód alebo názov)").fill("E2E-PL-CHYBA");
  await page.getByRole("button", { name: "Zobraziť" }).click();

  const riadok = page.getByTestId("product-link-row-E2E-PL-CHYBA");
  await expect(riadok).toBeVisible();
  await expect(riadok).toContainText("E2E Dodávateľ Párovanie");
  await expect(page.getByTestId("product-link-status-E2E-PL-CHYBA")).toHaveText("—");

  await riadok.getByTestId("product-link-edit-toggle-E2E-PL-CHYBA").click();
  const vstup = page.getByTestId("product-link-edit-input-E2E-PL-CHYBA");
  await expect(vstup).toBeVisible();
  await expect(vstup).toHaveValue("");
  await vstup.fill("https://e2e-dodavatel.example.com/parovanie-nova");
  await page.getByTestId("product-link-save-E2E-PL-CHYBA").click();

  // Po uložení produkt už MÁ linku — predvolený filter "Bez linky" ho už
  // nezobrazí, treba prepnúť na "Všetky", aby bolo vidno stav.
  await page.getByLabel("Zobraziť produkty").selectOption("all");
  await page.getByRole("button", { name: "Zobraziť" }).click();
  const riadokPoUlozeni = page.getByTestId("product-link-row-E2E-PL-CHYBA");
  await expect(riadokPoUlozeni.getByTestId("product-link-url-E2E-PL-CHYBA")).toHaveAttribute(
    "href",
    "https://e2e-dodavatel.example.com/parovanie-nova",
  );
  await expect(page.getByTestId("product-link-status-E2E-PL-CHYBA")).toContainText("čaká na odoslanie");

  // Pretrvanie po obnovení stránky — linka je v DB
  // (`product_supplier_link_override`), nielen v optimistickom klientskom stave.
  await page.reload();
  await page.getByLabel("Zobraziť produkty").selectOption("all");
  await page.getByLabel("Hľadať produkt (kód alebo názov)").fill("E2E-PL-CHYBA");
  await page.getByRole("button", { name: "Zobraziť" }).click();
  await expect(page.getByTestId("product-link-url-E2E-PL-CHYBA")).toHaveAttribute(
    "href",
    "https://e2e-dodavatel.example.com/parovanie-nova",
  );

  // Existujúca (fixtúrová) linka "E2E-PL-OPRAVA" — filter "S linkou", ✏️
  // Upraviť ponúkne AKTUÁLNU hodnotu ako predvyplnenú, nová hodnota prepíše
  // pôvodnú bez akejkoľvek "už má hodnotu" gaty.
  await page.getByLabel("Zobraziť produkty").selectOption("linked");
  await page.getByLabel("Hľadať produkt (kód alebo názov)").fill("E2E-PL-OPRAVA");
  await page.getByRole("button", { name: "Zobraziť" }).click();
  const riadokOprava = page.getByTestId("product-link-row-E2E-PL-OPRAVA");
  await expect(riadokOprava.getByTestId("product-link-url-E2E-PL-OPRAVA")).toHaveAttribute(
    "href",
    "https://e2e-dodavatel.example.com/parovanie-oprava-povodna",
  );
  await expect(page.getByTestId("product-link-status-E2E-PL-OPRAVA")).toContainText("čaká na odoslanie");

  await riadokOprava.getByTestId("product-link-edit-toggle-E2E-PL-OPRAVA").click();
  const vstupOprava = page.getByTestId("product-link-edit-input-E2E-PL-OPRAVA");
  await expect(vstupOprava).toHaveValue("https://e2e-dodavatel.example.com/parovanie-oprava-povodna");
  await vstupOprava.fill("https://e2e-dodavatel.example.com/parovanie-oprava-nova");
  await page.getByTestId("product-link-save-E2E-PL-OPRAVA").click();

  await expect(page.getByTestId("product-link-url-E2E-PL-OPRAVA")).toHaveAttribute(
    "href",
    "https://e2e-dodavatel.example.com/parovanie-oprava-nova",
  );

  expect(chyby).toEqual([]);
});

// issue 153 (rovnaká disciplína ako `orders-supplier-link.spec.ts`): neplatný
// odkaz sa odmietne HNEĎ v prehliadači — konzola musí zostať čistá (dôkaz, že
// sa nikdy neodoslal skutočný request na server).
test("neplatný odkaz sa odmietne HNEĎ, bez zápisu na server (konzola čistá)", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=supplier-links");
  await page.getByLabel("E-mail").fill(E2E_PAROVANIE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Párovanie produktov" })).toBeVisible();

  await page.getByLabel("Zobraziť produkty").selectOption("all");
  await page.getByLabel("Hľadať produkt (kód alebo názov)").fill("E2E-PL-OPRAVA");
  await page.getByRole("button", { name: "Zobraziť" }).click();

  const riadok = page.getByTestId("product-link-row-E2E-PL-OPRAVA");
  await riadok.getByTestId("product-link-edit-toggle-E2E-PL-OPRAVA").click();
  const vstup = page.getByTestId("product-link-edit-input-E2E-PL-OPRAVA");
  await vstup.fill("nieje-url");
  await page.getByTestId("product-link-save-E2E-PL-OPRAVA").click();

  await expect(page.getByText("Odkaz musí byť platná adresa začínajúca http:// alebo https://.")).toBeVisible();

  expect(chyby).toEqual([]);
});
