import { expect, test, type ConsoleMessage } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze

// Rovnaká a JEDINÁ povolená výnimka ako v login.spec.ts/catalog.spec.ts/orders.spec.ts.
const jeOcakavane = (m: ConsoleMessage): boolean =>
  m.location().url.includes("/api/me") && m.text().includes("401");

// #57: "Kontrola párovania" je od nového ľavého menu SKRYTÁ obrazovka
// (viditeľné sú len "Sync zo Shoptetu"/"Na objednanie") — kód aj testy
// ostávajú, dostupná ďalej cez priamy odkaz `?tab=pairing` (`nav.ts`'s
// HIDDEN_TABS).

// #45: obrazovka "Kontrola párovania". `pairing` tabuľka nemá pri E2E setupe
// ŽIADEN riadok (#46 automatické hľadanie kandidátov ešte neexistuje) — variant
// "4859/46" (`scripts/e2e-setup.ts`, dodávateľ "DODAVATEL-TEST-1") sa preto pri
// PRVOM zobrazení musí ukázať ako "Navrhnuté" s prázdnou adresou (LEFT JOIN,
// nie INNER — viď návrhový komentár na issue 45), a manažér ho tu VÔBEC PRVÝKRÁT
// napáruje ručne zadanou adresou.
//
// "Nohavice Hart Wild-T" (guid nižšie) má vo fixtúre 7 veľkostí (46-58),
// VŠETKY bez adresy → homogénna skupina → issue 47 (F4 rozdelenie podľa
// veľkostí) ju pri PRVOM zobrazení zbalí do JEDNÉHO riadku. Test najprv
// klikne "✂ Rozdeliť na veľkosti", aby sa dostal na PÔVODNÝ per-veľkostný
// riadok "4859/46" — samotný scenár (ručné napárovanie JEDNEJ veľkosti bez
// kandidáta) sa tým nemení.
const NOHAVICE_HART_PRODUCT_KEY = "611a6160-e5b1-11e8-a065-0cc47a6c92bc";

test("manažér ručne napáruje variant bez existujúceho kandidáta, zmena pretrvá po obnovení stránky, konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=pairing");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Kontrola párovania" })).toBeVisible();

  await page.getByTestId(`split-${NOHAVICE_HART_PRODUCT_KEY}`).click();
  const riadok = page.getByTestId("pairing-4859/46");
  await expect(riadok).toBeVisible();
  await expect(riadok).toContainText("Nohavice Hart Wild-T");
  await expect(riadok).toContainText("DODAVATEL-TEST-1");
  await expect(riadok).toContainText("Navrhnuté");
  // Bez uloženej adresy je "✓ Potvrdiť" disabled — nie je čo potvrdiť jedným klikom.
  await expect(riadok.getByTestId("confirm-4859/46")).toBeDisabled();

  await riadok.getByTestId("reject-4859/46").click();
  await riadok.getByLabel("Adresa u dodávateľa pre 4859/46").fill("https://www.grube.sk/p/nohavice-hart-wild-t/1");
  await riadok.getByRole("button", { name: "Potvrdiť" }).click();

  await expect(riadok).toContainText("Potvrdené");
  await expect(riadok).toContainText("E2E Manažér");
  await expect(riadok.getByRole("link", { name: "https://www.grube.sk/p/nohavice-hart-wild-t/1" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Kontrola párovania" })).toBeVisible();
  const riadokPoReloade = page.getByTestId("pairing-4859/46");
  await expect(riadokPoReloade).toContainText("Potvrdené");
  await expect(
    riadokPoReloade.getByRole("link", { name: "https://www.grube.sk/p/nohavice-hart-wild-t/1" }),
  ).toBeVisible();

  expect(chyby).toEqual([]);
});

// Variant "40287" (bez dodávateľa) má `scripts/e2e-setup.ts`'s ZÁMERNE
// PREDNASTAVENÝ, ešte nepotvrdený pairing kandidát (simuluje to, čo by inak
// vložilo budúce #46) — jediný spôsob, ako cez SKUTOČNÝ prehliadač overiť
// "✓ Potvrdiť jedným klikom" (appka sama dnes žiadny takýto riadok
// nevytvorí, viď komentár v `e2e-setup.ts`). Tá istá stránka aj overuje
// filter podľa stavu.
test("manažér potvrdí navrhnutú adresu jedným klikom, filter podľa stavu funguje, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=pairing");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Kontrola párovania" })).toBeVisible();

  const riadok = page.getByTestId("pairing-40287");
  await expect(riadok).toBeVisible();
  await expect(riadok).toContainText("Čiapka Polar FOREST");
  await expect(riadok).toContainText("Navrhnuté");
  await expect(riadok.getByRole("link", { name: "https://www.grube.sk/p/ciapka-polar-forest/1" })).toBeVisible();

  await riadok.getByTestId("confirm-40287").click();
  await expect(riadok).toContainText("Potvrdené");
  await expect(riadok).toContainText("E2E Manažér");
  // Adresa ostáva NEZMENENÁ — jedným klikom sa potvrdila tá istá, uložená.
  await expect(riadok.getByRole("link", { name: "https://www.grube.sk/p/ciapka-polar-forest/1" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.getByLabel("Stav párovania").selectOption("navrhnute");
  await page.getByRole("button", { name: "Filtrovať" }).click();
  await expect(page.getByTestId("pairing-40287")).toHaveCount(0);

  await page.getByLabel("Stav párovania").selectOption("potvrdene");
  await page.getByRole("button", { name: "Filtrovať" }).click();
  await expect(page.getByTestId("pairing-40287")).toBeVisible();

  await page.getByLabel("Stav párovania").selectOption("all");
  await page.getByRole("button", { name: "Filtrovať" }).click();

  expect(chyby).toEqual([]);
});

// Issue 47 (F4 rozdelenie podľa veľkostí). "Nohavice FOREST 1003" (guid
// "0a486205-d9e7-11e0-92ec-e1ef0b66e031") má vo fixtúre 9 veľkostí (3XL, 4XL,
// 5XL, 6XL, L, M, S, XL, XXL) a ŽIADEN z nich nemá v `scripts/e2e-setup.ts`
// prednastavený pairing riadok — takže sa pri PRVOM zobrazení ukáže ako JEDEN
// zbalený riadok (homogénne: všetkých 9 veľkostí má `supplierUrl: null`).
const PRODUCT_KEY = "0a486205-d9e7-11e0-92ec-e1ef0b66e031";

// VLASTNÝ účet (nie zdieľaný `e2e@forestshop.sk`) — `checkLoginRateLimit`
// (`apps/api/src/http/login-rate-limit.ts`) počíta KAŽDÝ `POST /api/login`
// proti dvojici (IP, e-mail), max. 10 v 5-minútovom okne, a celý e2e beh
// zdieľa JEDEN API server proces. So zvyškom balíka (catalog+login+orders+
// zvyšné pairing testy pod `e2e@forestshop.sk`) by TENTO test ako 11.
// prihlásenie pod tou istou dvojicou limit prekročil — reálne pozorované pri
// `--workers=2` ("Nesprávny e-mail alebo heslo"), nie flaka. Rovnaký
// mechanizmus ako `E2E_HESLO_ZMENA_EMAIL` v `scripts/e2e-setup.ts`, len iný
// dôvod izolácie (rate limit, nie súbežná mutácia hesla).
const E2E_SKUPINY_EMAIL = "e2e-skupiny@forestshop.sk";

test("manažér nastaví JEDNU adresu pre všetkých 9 veľkostí naraz, potom rozdelí a JEDNU veľkosť opraví na inú adresu bez dotknutia ostatných, konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=pairing");
  await page.getByLabel("E-mail").fill(E2E_SKUPINY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Kontrola párovania" })).toBeVisible();

  const skupina = page.getByTestId(`pairing-group-${PRODUCT_KEY}`);
  await expect(skupina).toBeVisible();
  await expect(skupina).toContainText("Nohavice FOREST 1003");
  await expect(skupina).toContainText("3XL, 4XL, 5XL, 6XL, L, M, S, XL, XXL");
  // Bez uloženej adresy je "✓ Potvrdiť" disabled — rovnaký dôvod ako v teste
  // vyššie (nič spoločné čo potvrdiť jedným klikom).
  await expect(skupina.getByTestId(`confirm-group-${PRODUCT_KEY}`)).toBeDisabled();
  await expect(page.getByTestId("pairing-40237/M")).toHaveCount(0); // zbalené, žiadne per-veľkostné riadky

  const bulkAdresa = "https://www.grube.sk/p/nohavice-forest-1003/1";
  await skupina.getByTestId(`reject-group-${PRODUCT_KEY}`).click();
  await skupina.getByLabel("Adresa u dodávateľa pre Nohavice FOREST 1003 (všetky veľkosti)").fill(bulkAdresa);
  await skupina.getByRole("button", { name: "Potvrdiť" }).click();

  await expect(skupina).toContainText("Potvrdené");
  await expect(skupina.getByRole("link", { name: bulkAdresa })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Kontrola párovania" })).toBeVisible();
  const skupinaPoReloade = page.getByTestId(`pairing-group-${PRODUCT_KEY}`);
  await expect(skupinaPoReloade).toContainText("Potvrdené");
  await expect(skupinaPoReloade.getByRole("link", { name: bulkAdresa })).toBeVisible();

  // Rozdelenie na veľkosti + oprava JEDNEJ veľkosti na INÚ adresu — jadro
  // issue 47 (per-size párovanie namiesto jedného spoločného, viď návrhový
  // komentár na issue 47/ticket 44).
  await skupinaPoReloade.getByTestId(`split-${PRODUCT_KEY}`).click();
  const riadokM = page.getByTestId("pairing-40237/M");
  const riadokL = page.getByTestId("pairing-40237/L");
  await expect(riadokM).toBeVisible();
  await expect(riadokM).toContainText("Potvrdené");
  await expect(riadokM.getByRole("link", { name: bulkAdresa })).toBeVisible();
  await expect(riadokL.getByRole("link", { name: bulkAdresa })).toBeVisible();

  const inaAdresa = "https://www.grube.sk/p/nohavice-forest-1003-m/1";
  await riadokM.getByTestId("reject-40237/M").click();
  await riadokM.getByLabel("Adresa u dodávateľa pre 40237/M").fill(inaAdresa);
  await riadokM.getByRole("button", { name: "Potvrdiť" }).click();

  await expect(riadokM.getByRole("link", { name: inaAdresa })).toBeVisible();
  // Susedná veľkosť ostáva NEDOTKNUTÁ — presne to, čo stará appka (JSON per
  // produkt) nevedela zaručiť (#273/#304 v starom repe).
  await expect(riadokL.getByRole("link", { name: bulkAdresa })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Kontrola párovania" })).toBeVisible();
  // Adresy sa teraz LÍŠIA naprieč veľkosťami → skupina je EFEKTÍVNE
  // rozdelená a zostáva zobrazená rozdelene AJ BEZ opätovného klikania.
  await expect(page.getByTestId(`pairing-group-${PRODUCT_KEY}`)).toHaveCount(0);
  const riadokMPoReloade = page.getByTestId("pairing-40237/M");
  await expect(riadokMPoReloade.getByRole("link", { name: inaAdresa })).toBeVisible();
  await expect(page.getByTestId("pairing-40237/L").getByRole("link", { name: bulkAdresa })).toBeVisible();

  expect(chyby).toEqual([]);
});
