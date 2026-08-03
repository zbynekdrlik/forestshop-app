import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_NEDOSTUPNE_EMAIL = "e2e-nedostupne@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 176: "Nedostupné tovary" je SKRYTÁ obrazovka (rovnaký vzor ako
// #172/#173 — majiteľ chce v ľavom menu zatiaľ len "Sync zo Shoptetu"/"Na
// objednanie", issue 57) — dostupná cez `?tab=nedostupne`.
//
// Toto NEKONTAKTUJE skutočný SMTP: `playwright.config.ts`'s API `webServer`
// nenastavuje `MAIL_HOST`, takže `mailTransport` je v tomto behu `undefined`
// (rovnaká úvaha ako `order-reminder.spec.ts`/`posta-uncollected.spec.ts`).
// Fixtúrová objednávka "9008" (`scripts/e2e-setup.ts`) má riadok variantu
// "40287" v stave 'nedostupne' — ten istý variant, ktorého katalógová
// fixtúra reálne nesie `relatedProduct = "60297"`, takže náhrada sa dá
// overiť naživo bez ďalšej fixtúry.
test("zoznam zobrazí nedostupný variant s náhradou, povinný náhľad predchádza odoslaniu, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=nedostupne");
  await page.getByLabel("E-mail").fill(E2E_NEDOSTUPNE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Nedostupné tovary" })).toBeVisible();

  // Chýbajúca BCC/mail konfigurácia (E2E beh) sa zobrazí ako varovania.
  await expect(page.getByTestId("nedostupne-bcc-missing")).toBeVisible();
  await expect(page.getByTestId("nedostupne-mail-not-configured")).toBeVisible();

  // Fixtúrová karta variantu "40287" s náhradou "60297" (neznámy kód —
  // padá späť na seba samého ako meno, `.claude/rules/nedostupne` návrhový
  // komentár na tickete).
  const group = page.getByTestId("nedostupne-group-40287");
  await expect(group).toBeVisible();
  await expect(group.getByText("60297")).toBeVisible();
  await expect(group.getByText("E2E Zákazník Nedostupné")).toBeVisible();

  // Klik na "náhľad" otvorí povinný náhľad e-mailu PRED akýmkoľvek odoslaním.
  await page.getByTestId("nedostupne-send-9008-40287").click();
  const preview = page.getByTestId("nedostupne-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("e2e-nedostupne@forestshop.sk");

  // Potvrdenie odoslania bez nakonfigurovaného mailu vráti graceful chybu
  // (fail-closed, žiadny skutočný pokus o SMTP spojenie) — BCC kontrola beží
  // PRED mail-transport kontrolou (`send.ts`), takže táto hláška sa zobrazí.
  await page.getByTestId("nedostupne-confirm-send").click();
  await expect(page.getByText("chýba adresa pre skrytú kópiu majiteľovi (NEDOSTUPNE_BCC_EMAIL)", { exact: true })).toBeVisible();

  expect(chyby).toEqual([]);
});
