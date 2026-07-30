import { expect, test, type ConsoleMessage } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze

// Rovnaká a JEDINÁ povolená výnimka ako v login.spec.ts/catalog.spec.ts.
const jeOcakavane = (m: ConsoleMessage): boolean =>
  m.location().url.includes("/api/me") && m.text().includes("401");

test("manažér vidí otvorené objednávky zoskupené podľa dodávateľa, konzola je čistá", async ({ page }) => {
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

  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // `scripts/e2e-setup.ts` zakladá objednávku 9001 nad variantom "4859/46",
  // ktorý má v exporte skutočného dodávateľa "DODAVATEL-TEST-1".
  const skupinaDodavatel = page.getByTestId("supplier-DODAVATEL-TEST-1");
  await expect(skupinaDodavatel).toBeVisible();
  const riadokAlfa = skupinaDodavatel.locator("[data-testid^='order-line-']");
  await expect(riadokAlfa).toContainText("9001");
  await expect(riadokAlfa).toContainText("E2E Zákazník Alfa");
  await expect(riadokAlfa).toContainText("4859/46");
  await expect(riadokAlfa).toContainText("Nohavice Hart Wild-T");
  await expect(riadokAlfa).toContainText("46");
  await expect(riadokAlfa).toContainText("2");
  await expect(riadokAlfa).toContainText("Čaká sa");
  await expect(riadokAlfa).toContainText("Zavolať pred doručením");

  // Objednávka 9002 je nad variantom "40287", ktorý nemá dodávateľa
  // (`product.supplier` je `null`) — zoskupí sa pod zástupný kľúč, nie pod
  // "null" a nezmizne.
  const skupinaBezDodavatela = page.getByTestId("supplier-(bez dodávateľa)");
  await expect(skupinaBezDodavatela).toBeVisible();
  const riadokBez = skupinaBezDodavatela.locator("[data-testid^='order-line-']");
  await expect(riadokBez).toContainText("9002");
  await expect(riadokBez).toContainText("E2E Zákazník Bez dodávateľa");
  await expect(riadokBez).toContainText("40287");
  await expect(riadokBez).toContainText("Čiapka Polar FOREST");
  // Predvolený stav riadku (schema default "objednane") a chýbajúca veľkosť.
  await expect(riadokBez).toContainText("Objednané");

  expect(chyby).toEqual([]);
});

// #25: manažér prepne stav riadku cez select v UI a zmena PRETRVÁ po obnovení
// stránky. Zápis stavu a audit bežia v JEDNEJ transakcii (`modules/orders/
// state.ts`) — pretrvanie po reloade je teda dôkazom, že transakcia skutočne
// commitla (audit zápis neyhodil výnimku, ktorá by ju bola vrátila späť).
// Samotný obsah auditového riadku (kto, kedy, z akého stavu do akého) overuje
// integračný test (`apps/api/tests/orders-http.integration.test.ts`) priamo
// nad databázou — tam patrí kontrola stĺpcov DB riadku, nie do e2e.
test("manažér prepne stav riadku cez select, zmena pretrvá po obnovení stránky, konzola je čistá", async ({ page }) => {
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
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // Objednávka 9001 (dodávateľ "DODAVATEL-TEST-1") má riadok so stavom
  // "caka_sa" (`scripts/e2e-setup.ts`).
  const riadok = page.getByTestId("supplier-DODAVATEL-TEST-1").locator("[data-testid^='order-line-']");
  const select = riadok.locator("select");
  await expect(select).toHaveValue("caka_sa");

  await select.selectOption("skladom");
  await expect(riadok).toContainText("Skladom");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  const riadokPoReloade = page.getByTestId("supplier-DODAVATEL-TEST-1").locator("[data-testid^='order-line-']");
  await expect(riadokPoReloade.locator("select")).toHaveValue("skladom");

  expect(chyby).toEqual([]);
});
