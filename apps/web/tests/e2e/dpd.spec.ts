import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// VLASTNÝ izolovaný účet (rovnaký mechanizmus ako `E2E_NAVRHY_ODKAZOV_EMAIL`,
// `.claude/rules/frontend-design.md`) — zdieľaný `e2e@forestshop.sk` je už
// na hranici `MAX_ATTEMPTS`. Musí sa zhodovať s `scripts/e2e-fixtures-dpd.ts`'s
// `E2E_DPD_EMAIL`.
const E2E_DPD_EMAIL = "e2e-dpd@forestshop.sk";

// issue 292: "Eshop → Preprava DPD" — VIDITEĽNÁ záložka (`nav.ts`).
// E2E prostredie NEMÁ nastavené `DPD_PORTAL_USER`/`PASSWORD` (appka teda
// beží ako "nenakonfigurovaná", presne ako by bežala pred vypýtaním
// prístupu) — appka preto MUSÍ ukázať zoznam objednávok (čisto DB čítanie,
// nezávisí od Playwright robota) a zablokovať tlačidlá, čo by inak volali
// skutočný DPD portál. Skutočné odoslanie zásielky je mimo dosahu e2e testu
// (appka sa NIKDY nesmie dotknúť reálneho DPD účtu, `.claude/rules/dpd.md`)
// — pokrýva ho `DpdSection.test.tsx` (izolované, s falošným API klientom).
test("zoznam objednávok, neúplná adresa je zablokovaná, appka je fail-closed bez DPD prihlásenia; konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_DPD_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await page.getByRole("button", { name: "Preprava DPD" }).click();
  await expect(page.getByRole("heading", { name: "Preprava DPD" })).toBeVisible();

  await expect(page.getByTestId("dpd-not-configured")).toBeVisible();

  // Pripravená objednávka (úplná adresa + dobierka) — checkbox je aktívny,
  // hmotnosť predvyplnená z uloženej hodnoty, dobierka zobrazená.
  const pripravena = page.getByTestId("dpd-order-row-9012");
  await expect(pripravena).toBeVisible();
  await expect(pripravena).toContainText("Testovacia 1, E2E Mesto 00000, Slovensko");
  await expect(pripravena).toContainText("19.90 €");
  const checkboxPripravena = page.getByLabel("Vybrať objednávku 9012");
  await expect(checkboxPripravena).toBeEnabled();
  const hmotnostPripravena = page.getByLabel("Hmotnosť objednávky 9012");
  await expect(hmotnostPripravena).toHaveValue("1.20");

  // Objednávka bez adresy — checkbox je ZABLOKOVANÝ, appka to nikdy
  // neponúkne na odoslanie robotovi s prázdnymi poľami.
  const bezAdresy = page.getByTestId("dpd-order-row-9013");
  await expect(bezAdresy).toBeVisible();
  await expect(page.getByTestId("dpd-address-incomplete-9013")).toBeVisible();
  await expect(page.getByLabel("Vybrať objednávku 9013")).toBeDisabled();

  // Appka je fail-closed bez DPD prihlásenia — tlačidlá, čo by inak volali
  // skutočný portál, sú zablokované, aj keď je objednávka vybraná.
  await checkboxPripravena.check();
  await expect(page.getByTestId("dpd-open-preview")).toBeDisabled();
  await expect(page.getByTestId("dpd-pickup-submit")).toBeDisabled();

  expect(chyby).toEqual([]);
});
