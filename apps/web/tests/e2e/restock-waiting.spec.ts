import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_PREPINANIE_EMAIL = "e2e-prepinanie@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 217 — majiteľ: "sprav mi jednoduchu webku kde si to rychlo overim,
// link na nas produkt a link na produkt dodavatela". Test preto overuje presne
// to, čo od obrazovky chce: nájsť čakajúci produkt a mať pri ňom OBA odkazy.
test("zoznam pripravených na prepnutie ponúkne odkaz na náš produkt aj k dodávateľovi; konzola je čistá", async ({
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

  // Obrazovka je dostupná z ľavého menu pod "Automatizácie".
  await page.getByRole("button", { name: "Vypredané → Skladom" }).click();
  await expect(page.getByTestId("restock-waiting-list")).toBeVisible();

  // Seedovaný kandidát (`scripts/e2e-setup.ts`) — vypredaný, viditeľný,
  // s čerstvým potvrdením dodávateľa.
  const riadok = page.getByTestId("restock-waiting-PREP-1");
  await expect(riadok).toBeVisible();
  await expect(riadok).toContainText("E2E Bunda na prepnutie");

  // Jadro zadania: odkaz na náš eshop (vyhľadanie podľa kódu) aj na dodávateľa,
  // oba do novej karty, aby preklikávanie zoznam nezavrelo.
  const nasOdkaz = riadok.getByRole("link", { name: "náš ↗" });
  await expect(nasOdkaz).toHaveAttribute("href", "https://www.forestshop.sk/vyhladavanie/?string=PREP-1");
  await expect(nasOdkaz).toHaveAttribute("target", "_blank");
  const odkazDodavatela = riadok.getByRole("link", { name: "dodávateľ ↗" });
  await expect(odkazDodavatela).toHaveAttribute("href", "https://huntingshop.eu/e2e-prepinanie");
  await expect(odkazDodavatela).toHaveAttribute("target", "_blank");

  // Filter podľa dodávateľa je pri tisíckach riadkov nutnosť — po jeho použití
  // musí riadok ostať (patrí tomu dodávateľovi).
  await page.getByTestId("restock-waiting-supplier").selectOption("DODAVATEL-PREPINANIE");
  await expect(page.getByTestId("restock-waiting-PREP-1")).toBeVisible();

  expect(chyby).toEqual([]);
});
