import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_PRIPOMIENKY_EMAIL = "e2e-pripomienky@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 173: "Pripomienky objednávok" je SKRYTÁ obrazovka (rovnaký vzor ako
// katalóg/párovanie/plánovač/#172 — majiteľ chce v ľavom menu zatiaľ len
// "Sync zo Shoptetu"/"Na objednanie", issue 57) — dostupná cez
// `?tab=order-reminder`.
//
// Toto NEKONTAKTUJE skutočné OpenAI ani skutočný SMTP: `playwright.config
// .ts`'s API `webServer` nenastavuje `OPENAI_API_KEY` ani `MAIL_HOST`, takže
// `classifyClient`/`mailTransport` sú v tomto behu `undefined` — rovnaká
// úvaha, akú `orders.md` dáva `sendSupplierOrderMail`u aj #172's tracking
// klientu. Objednávka "9002" (`scripts/e2e-setup.ts`) je stabilný, nikdy
// nemenený fixtúrový kandidát BEZ poznámky (a bez e-mailu) v predvolenom
// otvorenom stave — deterministicky vždy pristane v "🔴 bez poznámky".
test("Štart/Stop + Spustiť teraz fungujú, red-riadok má obe ručné akcie, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=order-reminder");
  await page.getByLabel("E-mail").fill(E2E_PRIPOMIENKY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Pripomienky objednávok" })).toBeVisible();

  // Nasadené VYPNUTÉ — majiteľova bezpečnostná podmienka.
  await expect(page.getByTestId("order-reminder-status-pill")).toHaveText("Zastavené");
  await expect(page.getByTestId("order-reminder-empty")).toBeVisible();

  await page.getByTestId("order-reminder-toggle").click();
  await expect(page.getByTestId("order-reminder-status-pill")).toHaveText("Beží");

  await page.getByTestId("order-reminder-run-now").click();
  await expect(page.getByText(/Skontrolovaných/)).toBeVisible();

  // Fixtúrová objednávka 9002 (bez poznámky, bez e-mailu) sa objaví v
  // červenej tabuľke, s OBOMA ručnými tlačidlami.
  const redRiadok = page.getByTestId("order-reminder-red-9002");
  await expect(redRiadok).toBeVisible();
  await expect(redRiadok.getByTestId("order-reminder-send-9002")).toBeVisible();
  await expect(redRiadok.getByTestId("order-reminder-contact-9002")).toBeVisible();

  // "✓ Kontaktované" ju vybaví ručne, bez e-mailu — zmizne z červenej
  // tabuľky, nikdy neposlala žiadny e-mail (žiadny MAIL_HOST v tomto behu,
  // takže akýkoľvek pokus o odoslanie by aj tak zlyhal 502/`ok:false`).
  await redRiadok.getByTestId("order-reminder-contact-9002").click();
  await expect(page.getByTestId("order-reminder-red-9002")).toHaveCount(0);
  await expect(page.getByTestId("order-reminder-skipped-9002")).toBeVisible();
  await expect(page.getByTestId("order-reminder-skipped-9002")).toContainText("vybavil ručne človek");

  // Vypnúť Štart/Stop znova — musí fungovať OBOMA smermi.
  await page.getByTestId("order-reminder-toggle").click();
  await expect(page.getByTestId("order-reminder-status-pill")).toHaveText("Zastavené");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Pripomienky objednávok" })).toBeVisible();
  await expect(page.getByTestId("order-reminder-status-pill")).toHaveText("Zastavené");

  expect(chyby).toEqual([]);
});
