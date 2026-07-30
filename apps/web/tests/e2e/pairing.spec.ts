import { expect, test, type ConsoleMessage } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze

// Rovnaká a JEDINÁ povolená výnimka ako v login.spec.ts/catalog.spec.ts/orders.spec.ts.
const jeOcakavane = (m: ConsoleMessage): boolean =>
  m.location().url.includes("/api/me") && m.text().includes("401");

// #45: obrazovka "Kontrola párovania". `pairing` tabuľka nemá pri E2E setupe
// ŽIADEN riadok (#46 automatické hľadanie kandidátov ešte neexistuje) — variant
// "4859/46" (`scripts/e2e-setup.ts`, dodávateľ "DODAVATEL-TEST-1") sa preto pri
// PRVOM zobrazení musí ukázať ako "Navrhnuté" s prázdnou adresou (LEFT JOIN,
// nie INNER — viď návrhový komentár na issue 45), a manažér ho tu VÔBEC PRVÝKRÁT
// napáruje ručne zadanou adresou.
test("manažér ručne napáruje variant bez existujúceho kandidáta, zmena pretrvá po obnovení stránky, konzola je čistá", async ({
  page,
}) => {
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
  await expect(page.getByRole("heading", { name: "Kontrola párovania" })).toBeVisible();

  const riadok = page.getByTestId("pairing-4859/46");
  await expect(riadok).toBeVisible();
  await expect(riadok).toContainText("Nohavice Hart Wild-T");
  await expect(riadok).toContainText("DODAVATEL-TEST-1");
  await expect(riadok).toContainText("Navrhnuté");
  // Bez uloženej adresy je "✓ Potvrdiť" disabled — nie je čo potvrdiť jedným klikom.
  await expect(riadok.getByTestId("confirm-4859/46")).toBeDisabled();

  await riadok.getByTestId("reject-4859/46").click();
  await riadok.getByLabel("Adresa u dodávateľa pre 4859/46").fill("https://www.grube.sk/p/nohavice-hart-wild-t/1");
  await riadok.getByRole("button", { name: "Potvrdiť" }).click();

  await expect(riadok).toContainText("Potvrdené");
  await expect(riadok).toContainText("E2E Manažér");
  await expect(riadok.getByRole("link", { name: "https://www.grube.sk/p/nohavice-hart-wild-t/1" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Kontrola párovania" })).toBeVisible();
  const riadokPoReloade = page.getByTestId("pairing-4859/46");
  await expect(riadokPoReloade).toContainText("Potvrdené");
  await expect(
    riadokPoReloade.getByRole("link", { name: "https://www.grube.sk/p/nohavice-hart-wild-t/1" }),
  ).toBeVisible();

  expect(chyby).toEqual([]);
});

// Variant "40287" (bez dodávateľa) má `scripts/e2e-setup.ts`'s ZÁMERNE
// PREDNASTAVENÝ, ešte nepotvrdený pairing kandidát (simuluje to, čo by inak
// vložilo budúce #46) — jediný spôsob, ako cez SKUTOČNÝ prehliadač overiť
// "✓ Potvrdiť jedným klikom" (appka sama dnes žiadny takýto riadok
// nevytvorí, viď komentár v `e2e-setup.ts`). Tá istá stránka aj overuje
// filter podľa stavu.
test("manažér potvrdí navrhnutú adresu jedným klikom, filter podľa stavu funguje, konzola je čistá", async ({ page }) => {
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
  await expect(page.getByRole("heading", { name: "Kontrola párovania" })).toBeVisible();

  const riadok = page.getByTestId("pairing-40287");
  await expect(riadok).toBeVisible();
  await expect(riadok).toContainText("Čiapka Polar FOREST");
  await expect(riadok).toContainText("Navrhnuté");
  await expect(riadok.getByRole("link", { name: "https://www.grube.sk/p/ciapka-polar-forest/1" })).toBeVisible();

  await riadok.getByTestId("confirm-40287").click();
  await expect(riadok).toContainText("Potvrdené");
  await expect(riadok).toContainText("E2E Manažér");
  // Adresa ostáva NEZMENENÁ — jedným klikom sa potvrdila tá istá, uložená.
  await expect(riadok.getByRole("link", { name: "https://www.grube.sk/p/ciapka-polar-forest/1" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.getByLabel("Stav párovania").selectOption("navrhnute");
  await page.getByRole("button", { name: "Filtrovať" }).click();
  await expect(page.getByTestId("pairing-40287")).toHaveCount(0);

  await page.getByLabel("Stav párovania").selectOption("potvrdene");
  await page.getByRole("button", { name: "Filtrovať" }).click();
  await expect(page.getByTestId("pairing-40287")).toBeVisible();

  await page.getByLabel("Stav párovania").selectOption("all");
  await page.getByRole("button", { name: "Filtrovať" }).click();

  expect(chyby).toEqual([]);
});
