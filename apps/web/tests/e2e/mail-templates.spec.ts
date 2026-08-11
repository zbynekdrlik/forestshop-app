import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_MAILY_EMAIL = "e2e-maily@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 192: "Texty e-mailov" — obrazovka je v ľavom menu pod "Systém".
// Nič sa tu neodosiela: tieto trasy len čítajú a zapisujú ZNENIE e-mailu,
// žiadny mail transport sa nedotknú (`playwright.config.ts` navyše serveru
// nenastavuje `MAIL_HOST`).
test("úprava znenia e-mailu: vloženie poľa, živý náhľad, uloženie a vrátenie pôvodného; konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_MAILY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // Obrazovka je dostupná z ľavého menu (nie skrytá za `?tab=`).
  // issue 343: priečinok "Systém" štartuje zbalený — treba ho najprv rozbaliť.
  await page.getByRole("button", { name: "Systém" }).click();
  await page.getByRole("button", { name: "Texty e-mailov" }).click();
  await expect(page.getByTestId("mail-template-list")).toBeVisible();

  // Prvý druh sa otvorí sám; prepneme na pripomienku objednávok, aby test
  // zároveň overil prepínanie medzi druhmi.
  await page.getByTestId("mail-template-pick-order_reminder").click();
  await expect(page.getByTestId("mail-template-editor-order_reminder")).toBeVisible();
  await expect(page.getByTestId("mail-template-original")).toBeVisible();

  // Náhľad sa počíta na serveri z rozpísaného znenia.
  await expect(page.getByTestId("mail-template-preview")).toContainText("Dobrý deň");

  const predmet = page.getByTestId("mail-template-subject");
  await predmet.fill("E2E predmet ");
  // Kliknutie na pole ho vloží do NAPOSLEDY zameraného vstupu — tu do predmetu.
  await page.getByTestId("mail-template-chip-cislo_objednavky").click();
  await expect(predmet).toHaveValue("E2E predmet {{cislo_objednavky}}");

  // Náhľad predmetu sa prepočíta a zástupné pole je v ňom už nahradené.
  await expect(page.getByTestId("mail-template-preview-subject")).toContainText("E2E predmet");
  await expect(page.getByTestId("mail-template-preview-subject")).not.toContainText("{{");

  await page.getByTestId("mail-template-save").click();
  await expect(page.getByTestId("mail-template-saved")).toBeVisible();
  await expect(page.getByTestId("mail-template-customized")).toBeVisible();

  // Uložené znenie prežije obnovenie stránky.
  await page.reload();
  // issue 343: obnovenie stránky = nové vykreslenie, priečinok je opäť zbalený.
  await page.getByRole("button", { name: "Systém" }).click();
  await page.getByRole("button", { name: "Texty e-mailov" }).click();
  await page.getByTestId("mail-template-pick-order_reminder").click();
  await expect(page.getByTestId("mail-template-subject")).toHaveValue("E2E predmet {{cislo_objednavky}}");

  // História zaznamenala zmenu.
  await page.getByTestId("mail-template-history-load").click();
  await expect(page.getByTestId("mail-template-history")).toContainText("uložené nové znenie");

  // Vrátenie pôvodného znenia vráti obrazovku do východiskového stavu —
  // fixtúra tak ostáva rovnaká pre ďalšie testy aj ďalšie behy.
  await page.getByTestId("mail-template-reset").click();
  await expect(page.getByTestId("mail-template-original")).toBeVisible();
  await expect(page.getByTestId("mail-template-subject")).toHaveValue("📦 Stav vašej objednávky z Forestshop.sk");

  // Druhá časť v TOM ISTOM teste (jedno prihlásenie): neplatná šablóna. E2E
  // balík je na strope 30 prihlásení na IP za 5 minút
  // (`IP_MAX_ATTEMPTS`, `login-rate-limit.ts`) — ďalší samostatný test s
  // vlastným prihlásením by ho pretiekol a zhodil NÁHODNÝ neskorší spec
  // súbor (`.claude/rules/testing.md`).
  await page.getByTestId("mail-template-pick-nedostupne").click();
  await expect(page.getByTestId("mail-template-editor-nedostupne")).toBeVisible();

  await page.getByTestId("mail-template-body").fill("Dobrý deň, {{vymyslene_pole}}");
  // Náhľad chybu ohlási hneď, ešte pred uložením.
  await expect(page.getByTestId("mail-template-preview-error")).toContainText("{{vymyslene_pole}}");

  await page.getByTestId("mail-template-save").click();
  await expect(page.getByTestId("mail-template-error")).toContainText("{{vymyslene_pole}}");
  // Neuložilo sa — šablóna ostáva pôvodná.
  await expect(page.getByTestId("mail-template-original")).toBeVisible();

  // Neplatná šablóna NESMIE vyrobiť konzolovú chybu — server ju vracia ako
  // 200 s vysvetlením, nikdy ako 4xx (`.claude/rules/testing.md`).
  expect(chyby).toEqual([]);
});
