import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_FARBY_EMAIL = "e2e-farby@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 264: koliesko "Farby aplikácie" vpravo hore — živý náhľad počas
// ťahania/písania, uloženie, vrátenie predvolených, zrušenie bez zápisu.
test("koliesko farieb: živý náhľad, uloženie prežije reload, vrátenie predvolených, Zrušiť nič neuloží; konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_FARBY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // "Na objednanie" je predvolená obrazovka pre citanie/manazer? Nie —
  // predvolená je "Sync zo Shoptetu" (nav.ts). Koliesko je v Topbar na
  // KAŽDEJ obrazovke, takže sa netreba prepínať nikam.
  const btn = page.getByTestId("themecolor-btn");
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.getByTestId("themecolor-dialog")).toBeVisible();

  const hexDone = page.getByTestId("themecolor-hex-chip-done-bg");
  await expect(hexDone).toHaveValue("#d14d3b");

  // Živý náhľad: písanie do hex poľa premietne CSS premennú na
  // document.documentElement OKAMŽITE, ešte pred uložením.
  await hexDone.fill("#123456");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--chip-done-bg")))
    .toBe("#123456");

  await page.getByTestId("themecolor-save").click();
  await expect(page.getByTestId("themecolor-dialog")).toBeHidden();

  // Uložená hodnota prežije obnovenie stránky — App.tsx ju premietne pri
  // prihlásení pre KAŽDÉHO používateľa, nielen v popupe.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--chip-done-bg")))
    .toBe("#123456");

  await btn.click();
  await expect(page.getByTestId("themecolor-dialog")).toBeVisible();
  await expect(page.getByTestId("themecolor-hex-chip-done-bg")).toHaveValue("#123456");

  // Zrušiť (bez uloženia zmeny) vráti live-náhľad na hodnotu PRI OTVORENÍ,
  // nikdy na predvolenú — a nič nezapíše na server.
  await page.getByTestId("themecolor-hex-chip-done-bg").fill("#abcdef");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--chip-done-bg")))
    .toBe("#abcdef");
  await page.getByTestId("themecolor-cancel").click();
  await expect(page.getByTestId("themecolor-dialog")).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--chip-done-bg")))
    .toBe("#123456");

  // issue 264 živé overenie (0.3.0-dev.153): neplatný kód farby musí
  // majiteľovi ZROZUMITEĽNE povedať prečo — nielen ticho zablokovať Uložiť.
  await btn.click();
  await expect(page.getByTestId("themecolor-dialog")).toBeVisible();
  const hexDoneAgain = page.getByTestId("themecolor-hex-chip-done-bg");
  await hexDoneAgain.fill("nezmysel");
  await expect(page.getByTestId("themecolor-hex-invalid")).toBeVisible();
  await expect(page.getByTestId("themecolor-hex-invalid")).toContainText("#RRGGBB");
  await expect(hexDoneAgain).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("themecolor-save")).toBeDisabled();
  await hexDoneAgain.fill("#654321");
  await expect(page.getByTestId("themecolor-hex-invalid")).toBeHidden();
  await expect(hexDoneAgain).toHaveAttribute("aria-invalid", "false");
  await page.getByTestId("themecolor-cancel").click();
  await expect(page.getByTestId("themecolor-dialog")).toBeHidden();

  // Obnoviť predvolené — persistentné hneď (rovnaký vzor ako "Texty
  // e-mailov"'s vrátenie pôvodného znenia), fixtúra tak ostáva rovnaká pre
  // ďalšie behy.
  await btn.click();
  await page.getByTestId("themecolor-reset").click();
  await expect(page.getByTestId("themecolor-hex-chip-done-bg")).toHaveValue("#d14d3b");
  await page.getByTestId("themecolor-cancel").click();

  expect(chyby).toEqual([]);
});
