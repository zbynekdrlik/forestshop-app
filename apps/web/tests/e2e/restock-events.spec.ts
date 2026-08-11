import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_PREPINANIE_EMAIL = "e2e-prepinanie@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 329 — majiteľ: "chcem mať aj link na naše produkty, nech si to viem
// overiť", konkrétne pre UŽ prepnuté produkty ("Prepnuté produkty" — dnes sa
// vie dostať len na stránku dodávateľa). Test overuje presne to: odkaz na náš
// produkt, do novej karty, a že chýbajúca adresa z feedu sa NEVYKRESLÍ ako
// mŕtvy odkaz.
test("história prepnutí ponúkne odkaz na náš produkt z feedu, bez neho sa nič nerozbije; konzola je čistá", async ({
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
  await page.getByLabel("E-mail").fill(E2E_PREPINANIE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // issue 343: priečinok "Automatizácie" štartuje zbalený — treba ho najprv rozbaliť.
  await page.getByRole("button", { name: "Automatizácie" }).click();
  await page.getByRole("button", { name: "Vypredané → Skladom", exact: true }).click();

  // Seedovaná udalosť S adresou z feedu (`scripts/e2e-fixtures-restock-events.ts`).
  const sOdkazom = page.getByTestId("restock-event-PREP-EVT-1");
  await expect(sOdkazom).toBeVisible();
  const nasOdkaz = sOdkazom.getByRole("link", { name: "náš ↗" });
  await expect(nasOdkaz).toHaveAttribute("href", "https://www.forestshop.sk/e2e-prepnuta-1/");
  await expect(nasOdkaz).toHaveAttribute("target", "_blank");
  const riadokVyska = await sOdkazom.evaluate((el) => el.getBoundingClientRect().height);

  // Seedovaná udalosť BEZ adresy z feedu — odkaz sa nesmie zobraziť vôbec,
  // riadok sa vykreslí bez chyby (majiteľ: "odkaz sa proste nezobrazí").
  const bezOdkazu = page.getByTestId("restock-event-PREP-EVT-2");
  await expect(bezOdkazu).toBeVisible();
  await expect(bezOdkazu.getByRole("link", { name: "náš ↗" })).toHaveCount(0);
  await expect(bezOdkazu).toContainText("E2E Bunda Prepnutá Bez Odkazu");

  // Kompaktnosť (issues 303/327): riadok bez odkazu nesmie byť VYŠŠÍ než
  // riadok s odkazom — nový stĺpec nesmie zväčšiť výšku riadku.
  const bezOdkazuVyska = await bezOdkazu.evaluate((el) => el.getBoundingClientRect().height);
  expect(bezOdkazuVyska).toBeLessThanOrEqual(riadokVyska + 1);

  expect(chyby).toEqual([]);
});
