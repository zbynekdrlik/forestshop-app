import { expect, test, type ConsoleMessage } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze

// Rovnaká a JEDINÁ povolená výnimka ako v login.spec.ts/catalog.spec.ts/orders.spec.ts/pairing.spec.ts.
const jeOcakavane = (m: ConsoleMessage): boolean => m.location().url.includes("/api/me") && m.text().includes("401");

// issue 172: "Nevyzdvihnuté zásielky" je SKRYTÁ obrazovka (rovnaký vzor ako
// katalóg/párovanie/plánovač — majiteľ chce v ľavom menu zatiaľ len "Sync zo
// Shoptetu"/"Na objednanie", issue 57) — dostupná cez `?tab=posta-uncollected`.
//
// Toto NEKONTAKTUJE skutočné api.posta.sk ani skutočný SMTP: `scripts/
// e2e-setup.ts`'s seedované objednávky NIKDY nemajú `packageNumber` (nový
// stĺpec, nikde v tomto skripte nastavený) — `runPostaUncollected` preto na
// tomto E2E behu vždy skončí s `checked=0` a Pošta SK API sa nezavolá ANI
// RAZ, bez ohľadu na to, že API server beží so SKUTOČNÝM tracking klientom
// (rovnaká úvaha, akú `orders.md` dáva `sendSupplierOrderMail`u — E2E
// nemôže MAIL_HOST nastaviť, takže odosielanie ostáva nenakonfigurované).
test("Štart/Stop + Spustiť teraz fungujú, prázdny výsledok sa zobrazí správne, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=posta-uncollected");
  await page.getByLabel("E-mail").fill("e2e-posta@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Nevyzdvihnuté zásielky" })).toBeVisible();

  // Nasadené VYPNUTÉ — bezpečnostná podmienka ticketu.
  await expect(page.getByTestId("posta-status-pill")).toHaveText("Zastavené");
  await expect(page.getByTestId("posta-empty")).toBeVisible();

  await page.getByTestId("posta-toggle").click();
  await expect(page.getByTestId("posta-status-pill")).toHaveText("Beží");

  await page.getByTestId("posta-run-now").click();
  await expect(page.getByText(/Skontrolovaných 0/)).toBeVisible();
  await expect(page.getByTestId("posta-none-uncollected")).toBeVisible();

  // Vypnúť znova — Štart/Stop musí fungovať OBOMA smermi.
  await page.getByTestId("posta-toggle").click();
  await expect(page.getByTestId("posta-status-pill")).toHaveText("Zastavené");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Nevyzdvihnuté zásielky" })).toBeVisible();
  await expect(page.getByTestId("posta-status-pill")).toHaveText("Zastavené");

  expect(chyby).toEqual([]);
});
