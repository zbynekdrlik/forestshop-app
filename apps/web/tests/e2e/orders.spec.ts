import { expect, test, type ConsoleMessage } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze

// #57: nové ľavé menu má "Na objednanie" ako záložku pod priečinkom Eshop,
// nie ako predvolenú (tá je "Sync zo Shoptetu") — `?tab=orders` ju vyberie
// priamo, bez potreby klikať cez sidebar v každom teste.

// Rovnaká a JEDINÁ povolená výnimka ako v login.spec.ts/catalog.spec.ts.
const jeOcakavane = (m: ConsoleMessage): boolean =>
  m.location().url.includes("/api/me") && m.text().includes("401");

test("manažér vidí otvorené objednávky zoskupené podľa dodávateľa, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // `scripts/e2e-setup.ts` zakladá objednávku 9001 nad variantom "4859/46",
  // ktorý má v exporte skutočného dodávateľa "DODAVATEL-TEST-1".
  const skupinaDodavatel = page.getByTestId("supplier-DODAVATEL-TEST-1");
  await expect(skupinaDodavatel).toBeVisible();
  const riadokAlfa = skupinaDodavatel.locator("[data-testid^='order-line-']");
  await expect(riadokAlfa).toContainText("9001");
  await expect(riadokAlfa).toContainText("E2E Zákazník Alfa");
  await expect(riadokAlfa).toContainText("4859/46");
  await expect(riadokAlfa).toContainText("Nohavice Hart Wild-T");
  await expect(riadokAlfa).toContainText("46");
  await expect(riadokAlfa).toContainText("2");
  await expect(riadokAlfa).toContainText("Čaká sa");
  await expect(riadokAlfa).toContainText("Zavolať pred doručením");

  // issue 67: fixtúra ("4859/46") má reálny holý odkaz na dodávateľa
  // (`internalNote`) aj kód dodávateľa (`externalCode`, "OB832") —
  // over cez map-row.test.ts, ak sa fixtúra niekedy zmení.
  const odkazAlfa = riadokAlfa.getByRole("link", { name: "Odkaz na dodávateľa" });
  await expect(odkazAlfa).toHaveAttribute("href", "https://www.huntingshop.eu/wild-t-green-nohavice");
  await expect(riadokAlfa).toContainText("OB832");

  // Objednávka 9002 je nad variantom "40287", ktorý nemá dodávateľa
  // (`product.supplier` je `null`) — zoskupí sa pod zástupný kľúč, nie pod
  // "null" a nezmizne.
  const skupinaBezDodavatela = page.getByTestId("supplier-(bez dodávateľa)");
  await expect(skupinaBezDodavatela).toBeVisible();
  const riadokBez = skupinaBezDodavatela.locator("[data-testid^='order-line-']");
  await expect(riadokBez).toContainText("9002");
  await expect(riadokBez).toContainText("E2E Zákazník Bez dodávateľa");
  await expect(riadokBez).toContainText("40287");
  await expect(riadokBez).toContainText("Čiapka Polar FOREST");
  // Predvolený stav riadku (schema default "objednane") a chýbajúca veľkosť.
  await expect(riadokBez).toContainText("Objednané");

  expect(chyby).toEqual([]);
});

// #25: manažér prepne stav riadku cez select v UI a zmena PRETRVÁ po obnovení
// stránky. Zápis stavu a audit bežia v JEDNEJ transakcii (`modules/orders/
// state.ts`) — pretrvanie po reloade je teda dôkazom, že transakcia skutočne
// commitla (audit zápis neyhodil výnimku, ktorá by ju bola vrátila späť).
// Samotný obsah auditového riadku (kto, kedy, z akého stavu do akého) overuje
// integračný test (`apps/api/tests/orders-http.integration.test.ts`) priamo
// nad databázou — tam patrí kontrola stĺpcov DB riadku, nie do e2e.
test("manažér prepne stav riadku cez select, zmena pretrvá po obnovení stránky, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // Objednávka 9001 (dodávateľ "DODAVATEL-TEST-1") má riadok so stavom
  // "caka_sa" (`scripts/e2e-setup.ts`).
  const riadok = page.getByTestId("supplier-DODAVATEL-TEST-1").locator("[data-testid^='order-line-']");
  const select = riadok.locator("select");
  await expect(select).toHaveValue("caka_sa");

  await select.selectOption("skladom");
  await expect(riadok).toContainText("Skladom");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  const riadokPoReloade = page.getByTestId("supplier-DODAVATEL-TEST-1").locator("[data-testid^='order-line-']");
  await expect(riadokPoReloade.locator("select")).toHaveValue("skladom");

  expect(chyby).toEqual([]);
});

// #31: e-mailový kontakt dodávateľa + náhľad objednávky mailom, cez skutočný
// prehliadač nad reálne naimportovanými fixtúrovými dátami (`scripts/
// e2e-setup.ts`). Skutočné ODOSLANIE (SMTP) sa tu zámerne NEKLIKÁ — MAIL_HOST
// nie je v e2e prostredí nakonfigurovaný (`playwright.config.ts`), takže
// server by na "Odoslať" vrátil 503, čo by (rovnako ako akýkoľvek iný
// 4xx/5xx fetch) zalogovalo console error a porušilo jedinú povolenú
// výnimku (`.claude/rules/testing.md`) — samotné odoslanie je overené
// integračne (`apps/api/tests/supplier-mail.integration.test.ts`) s falošným
// transportom. E2E overuje SKUTOČNÝ prehliadačový workflow: nastavenie
// e-mailu (perzistuje po reloade) a náhľad so správne agregovaným obsahom.
test("manažér nastaví e-mail dodávateľa a uvidí náhľad mailu so správne agregovaným obsahom, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // Objednávka 9001 (dodávateľ "DODAVATEL-TEST-1") má JEDINÝ riadok vo stave
  // "caka_sa" (`scripts/e2e-setup.ts`) — teda ŽIADNU otvorenú položku na
  // objednanie. Tlačidlo odoslania preto musí byť disabled, aj keď sa
  // e-mail dodávateľa nastaví — overuje, že disabled stav sleduje SKUTOČNÝ
  // stav riadkov, nie len prítomnosť e-mailu.
  const skupinaTest1 = page.getByTestId("supplier-DODAVATEL-TEST-1");
  await skupinaTest1.getByRole("button", { name: "Upraviť e-mail" }).click();
  await skupinaTest1.getByLabel("E-mail dodávateľa DODAVATEL-TEST-1").fill("test1@dodavatel.example");
  await skupinaTest1.getByRole("button", { name: "Uložiť" }).click();
  await expect(skupinaTest1.getByText("E-mail dodávateľa: test1@dodavatel.example")).toBeVisible();
  await expect(skupinaTest1.getByRole("button", { name: "✉️ Poslať objednávku e-mailom" })).toBeDisabled();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  await expect(
    page.getByTestId("supplier-DODAVATEL-TEST-1").getByText("E-mail dodávateľa: test1@dodavatel.example"),
  ).toBeVisible();

  // Objednávka 9002 (zástupný dodávateľ "(bez dodávateľa)") má riadok vo
  // východiskovom stave "objednane" — TÁ skupina má odoslanie povolené,
  // hneď ako dostane e-mail.
  const skupinaBezDodavatela = page.getByTestId("supplier-(bez dodávateľa)");
  await skupinaBezDodavatela.getByRole("button", { name: "Upraviť e-mail" }).click();
  await skupinaBezDodavatela.getByLabel("E-mail dodávateľa (bez dodávateľa)").fill("nezaradene@example.com");
  await skupinaBezDodavatela.getByRole("button", { name: "Uložiť" }).click();
  const poslatTlacidlo = skupinaBezDodavatela.getByRole("button", { name: "✉️ Poslať objednávku e-mailom" });
  await expect(poslatTlacidlo).toBeEnabled();
  await poslatTlacidlo.click();

  const nahlad = skupinaBezDodavatela.getByTestId("mail-preview-(bez dodávateľa)");
  await expect(nahlad).toBeVisible();
  await expect(nahlad).toContainText("nezaradene@example.com");
  // "40287" je jednovariantný produkt (žiadna veľkosť) s množstvom 1
  // (`scripts/e2e-setup.ts`) — presný, server-vypočítaný tvar riadku.
  await expect(nahlad).toContainText("Objednávka — (bez dodávateľa) (1 položka)");
  await expect(nahlad.locator("pre")).toHaveText("Objednávka — (bez dodávateľa) (1 položka)\n40287 | 1 ks");

  // Zrušenie náhľadu — v tomto teste sa zámerne NEODOSIELA (viď komentár
  // vyššie).
  await nahlad.getByRole("button", { name: "Zrušiť" }).click();
  await expect(nahlad).not.toBeVisible();

  expect(chyby).toEqual([]);
});
