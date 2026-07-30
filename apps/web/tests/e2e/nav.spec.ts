import { expect, test, type ConsoleMessage } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// Vlastný, IZOLOVANÝ účet len pre tento súbor (rovnaký dôvod aj mechanizmus
// ako `E2E_SKUPINY_EMAIL` v `pairing.spec.ts`/`scripts/e2e-setup.ts`): zdieľaný
// `e2e@forestshop.sk` mal už PRESNE 10 prihlásení naprieč zvyškom balíka
// (catalog 3 + login 2 + orders 3 + pairing 2), presne na hranici
// `MAX_ATTEMPTS` (`login-rate-limit.ts`) — pridanie ĎALŠÍCH 2 prihlásení sem by
// ju prekročilo a spôsobilo náhodné "Nesprávny e-mail alebo heslo" na inom
// teste v tom istom behu. Musí sa zhodovať s `E2E_NAV_EMAIL` v
// `scripts/e2e-setup.ts`.
const E2E_NAV_EMAIL = "e2e-nav@forestshop.sk";

// Rovnaká a JEDINÁ povolená výnimka ako v ostatných e2e súboroch.
const jeOcakavane = (m: ConsoleMessage): boolean =>
  m.location().url.includes("/api/me") && m.text().includes("401");

// #57: majiteľ chce naľavo PRESNE dve položky — záložku "Sync zo Shoptetu"
// v priečinku "Systém" a záložku "Na objednanie" v priečinku "Eshop", nič iné.
test("ľavé menu má presne dva priečinky s jednou záložkou každý, klik prepne obrazovku, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_NAV_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // Presne dva priečinky.
  await expect(page.getByRole("button", { name: "Systém" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Eshop" })).toBeVisible();

  // Presne dve záložky v CELOM menu — jedna na priečinok.
  await expect(page.locator(".side-nav .tab")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Sync zo Shoptetu" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Na objednanie" })).toBeVisible();

  // Predvolená obrazovka (bez kliknutia) je "Sync zo Shoptetu".
  await expect(page.getByRole("heading", { name: "Sync zo Shoptetu" })).toBeVisible();

  // Klik na "Na objednanie" prepne titulok aj obsah. `scripts/e2e-setup.ts`
  // vždy seeduje dve otvorené objednávky (`orders.spec.ts`'s prvý test) — táto
  // obrazovka teda NIKDY nie je prázdna v E2E prostredí, overujeme preto
  // skutočne prítomnú skupinu dodávateľa, nie prázdny stav.
  await page.getByRole("button", { name: "Na objednanie" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  await expect(page.getByTestId("supplier-DODAVATEL-TEST-1")).toBeVisible();

  expect(chyby).toEqual([]);
});

// #57: obrazovka konsoliduje "čo a kedy sa naposledy stiahlo zo Shoptetu" +
// tlačidlo na okamžité stiahnutie — dnes roztrúsené (tlačidlo v katalógu,
// história v plánovači). `scripts/e2e-setup.ts` nespúšťa žiaden scheduler tick
// a katalógový snapshot pre `catalog.spec.ts` vkladá priamo (obchádza
// scheduler), takže `job_run` je pri tomto teste prázdna — rovnaký stav ako
// login.spec.ts's "Plánovač" prázdny zoznam.
test("Sync zo Shoptetu ukazuje stav katalógu aj objednávok a tlačidlo 'Stiahnuť teraz', konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_NAV_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  const katalog = page.getByTestId("sync-channel-Katalóg");
  await expect(katalog).toContainText("Posledný beh: zatiaľ nikdy");
  await expect(katalog.getByRole("button", { name: "⚡ Stiahnuť teraz" })).toBeVisible();

  const objednavky = page.getByTestId("sync-channel-Objednávky");
  await expect(objednavky).toContainText("Posledný beh: zatiaľ nikdy");
  await expect(objednavky.getByRole("button", { name: "⚡ Stiahnuť teraz" })).toBeVisible();

  await expect(page.getByTestId("sync-history-empty")).toHaveText("Žiadny beh zatiaľ nie je zaznamenaný.");

  expect(chyby).toEqual([]);
});
