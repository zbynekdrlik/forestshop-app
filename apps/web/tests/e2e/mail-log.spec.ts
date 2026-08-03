import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_KNIHA_EMAIL = "e2e-kniha@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 193: "Odoslané e-maily" — prehľad toho, čo appka poslala. Táto
// obrazovka LEN číta; žiadny e-mail sa tu neodosiela (`playwright.config.ts`
// serveru ani nenastavuje `MAIL_HOST`).
test("prehľad odoslaných e-mailov ukáže súhrn, riadky s príjemcom a filtrovanie; konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_KNIHA_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // Obrazovka je dostupná z ľavého menu pod "Automatizácie".
  await page.getByRole("button", { name: "Odoslané e-maily" }).click();
  await expect(page.getByTestId("mail-log-table")).toBeVisible();

  // Súhrn: fixtúra má jeden odoslaný a jednu zablokovanú duplicitu.
  await expect(page.getByTestId("mail-log-sum-sent")).toContainText("1");
  await expect(page.getByTestId("mail-log-sum-duplicates")).toContainText("1");

  // Riadok nesie KOMU a ČOHO sa e-mail týkal — to je jadro zadania.
  const tabulka = page.getByTestId("mail-log-table");
  await expect(tabulka).toContainText("e2e-zakaznik@example.com");
  await expect(tabulka).toContainText("objednávka 9001");
  await expect(tabulka).toContainText("zásielka RR000000001SK");
  await expect(tabulka).toContainText("1. upozornenie");
  await expect(tabulka).toContainText("Odoslané");

  // Zablokovaná duplicita je vidno aj s dôvodom (ticketova podmienka
  // "ochrana pred dvojitým odoslaním musí byť z prehľadu viditeľná").
  await expect(tabulka).toContainText("Preskočené");
  await expect(tabulka).toContainText("už bolo odoslané skôr");

  // Filter podľa automatizácie zúži zoznam na jednu automatizáciu.
  await page.getByTestId("mail-log-filter-source").selectOption("posta_uncollected");
  await expect(tabulka).toContainText("Nevyzdvihnuté zásielky");
  await expect(tabulka).not.toContainText("Nedostupné tovary");

  // Obdobie, v ktorom sa nič neposielalo, ukáže vetu — nie prázdnu tabuľku.
  await page.getByTestId("mail-log-filter-source").selectOption("");
  await page.getByTestId("mail-log-filter-status").selectOption("failed");
  await expect(page.getByTestId("mail-log-empty")).toBeVisible();

  // Súhrn ostáva úplný aj pri zapnutom filtri stavu — inak by tvrdil, že sa
  // nič neodoslalo, hoci sa len nezobrazuje.
  await expect(page.getByTestId("mail-log-sum-sent")).toContainText("1");

  expect(chyby).toEqual([]);
});
