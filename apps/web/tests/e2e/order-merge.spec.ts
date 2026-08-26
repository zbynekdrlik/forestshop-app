import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_ZLUCENIE_EMAIL = "e2e-zlucenie@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 257: "Zlúčenie objednávok" — VIDITEĽNÁ záložka v "Eshop" (majiteľova
// korekcia zadania: vlastná záložka, ktorá SAMA vypíše zákazníkov s ≥2
// otvorenými objednávkami, nikdy tlačidlo pri jednotlivej objednávke).
//
// Toto NEKONTAKTUJE skutočný SMTP: `playwright.config.ts`'s API `webServer`
// nenastavuje `MAIL_HOST`/`ORDER_MERGE_BCC_EMAIL`, takže `mailTransport` je v
// tomto behu `undefined` (rovnaká úvaha ako `nedostupne.spec.ts`). Fixtúrové
// objednávky "9010"/"9011" (`scripts/e2e-setup.ts`) patria TOMU ISTÉMU
// (fiktívnemu) zákazníkovi — jediný kandidát na zlúčenie v celom e2e behu.
test("záložka vypíše zákazníkov s ≥2 otvorenými objednávkami, povinný náhľad predchádza odoslaniu, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=order-merge");
  await page.getByLabel("E-mail").fill(E2E_ZLUCENIE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Zlúčenie objednávok" })).toBeVisible();

  // Chýbajúca BCC/mail konfigurácia (E2E beh) sa zobrazí ako varovania —
  // rovnaký vzor ako "Nedostupné tovary".
  await expect(page.getByTestId("order-merge-bcc-missing")).toBeVisible();
  await expect(page.getByTestId("order-merge-mail-not-configured")).toBeVisible();

  const group = page.getByTestId("order-merge-group-9011");
  await expect(group).toBeVisible();
  await expect(group).toContainText("E2E Zákazník Zlúčenie");
  await expect(group).toContainText("e2e-zakaznik-zlucenie@example.sk");
  await expect(group).toContainText("č. 9010");
  await expect(group).toContainText("č. 9011");

  // issue 512: číslo objednávky je klikateľný odkaz do Shoptet administrácie
  // (rovnaký vzor ako „Na objednanie"/„Riešiť"). Seed objednávka nemá interné
  // Shoptet id, takže odkaz je vyhľadávací fallback `?string=<kód>`.
  const odkaz9010 = group.getByRole("link", { name: "Otvoriť objednávku 9010 v administrácii Shoptet" });
  await expect(odkaz9010).toBeVisible();
  const href9010 = await odkaz9010.getAttribute("href");
  expect(href9010).toMatch(/\/admin\//);
  expect(href9010).toContain("9010");

  // issue 512: menu odznak „Zlúčenie objednávok" ukazuje počet PRÍPADOV (osôb) —
  // kladné celé číslo, nikdy presné (zdieľaná seed DB seeduje viac objednávok,
  // `.claude/rules/testing.md`/#445).
  await expect(page.getByTestId("nav-badge-order-merge")).toHaveText(/^[1-9]\d*$/);

  // Klik otvorí POVINNÝ náhľad PRED akýmkoľvek odoslaním (rovnaký kontrakt
  // ako "Nedostupné tovary" — server-side vynútený token).
  await group.getByTestId("order-merge-send-9011").click();
  const preview = page.getByTestId("order-merge-preview");
  const previewBody = page.getByTestId("order-merge-preview-body");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("e2e-zakaznik-zlucenie@example.sk");
  // issue 277: text e-mailu je odteraz EDITOVATEĽNÝ (textarea, nie read-only
  // náhľad) — čísla objednávok sú v TELE (predmet ich nenesie), preto sa
  // overujú cez hodnotu poľa, nie cez textContent dialógu.
  await expect(previewBody).toHaveValue(/9010/);
  await expect(previewBody).toHaveValue(/9011/);

  // Zavrieť klávesom Esc bez odoslania — nič sa nezmení.
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();

  // Znovu otvoriť a potvrdiť — bez nakonfigurovaného mailu vráti graceful
  // chybu (fail-closed, žiadny skutočný pokus o SMTP spojenie); BCC kontrola
  // beží PRED mail-transport kontrolou (`merge-mail.ts`), takže táto hláška
  // sa zobrazí.
  await group.getByTestId("order-merge-send-9011").click();
  await expect(preview).toBeVisible();

  // issue 277: obsluha text priamo prepíše — appka to prijme (žiadna zmena
  // formátu, len nesmie zostať prázdne).
  await previewBody.fill("Dobrý deň, e2e zákazník — obe objednávky posielame spolu, vlastná veta z e2e testu.");
  await expect(previewBody).toHaveValue("Dobrý deň, e2e zákazník — obe objednávky posielame spolu, vlastná veta z e2e testu.");

  await page.getByTestId("order-merge-preview-confirm").click();
  await expect(page.getByText("chýba adresa pre skrytú kópiu majiteľovi (ORDER_MERGE_BCC_EMAIL)", { exact: true })).toBeVisible();

  // Neúspešné odoslanie náhľad ZÁMERNE nezatvára (obsluha vidí dôvod) —
  // zavrie ho až tlačidlo "Zrušiť".
  await expect(preview).toBeVisible();
  await page.getByTestId("order-merge-preview-cancel").click();
  await expect(preview).toBeHidden();

  expect(chyby).toEqual([]);
});
