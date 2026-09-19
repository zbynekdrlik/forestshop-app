import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// issue 548 (PR A): vlastný, IZOLOVANÝ účet len pre tento súbor (rovnaký dôvod aj
// mechanizmus ako `E2E_NAV_EMAIL` v `nav.spec.ts`/`scripts/e2e-setup.ts`): zdieľaný
// `e2e@forestshop.sk` je už na hranici `MAX_ATTEMPTS` (`login-rate-limit.ts`), ďalšie
// prihlásenie pod ním by spôsobilo náhodné "Nesprávny e-mail alebo heslo" inde v behu.
const E2E_SHELL_EMAIL = "e2e-shell@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 548 (PR A): zjednotenie dizajnu sekcií podľa vzoru „Na objednanie".
// Spoločné prezentačné primitívy (`components/section/`) dávajú KAŽDEJ dotknutej
// sekcii tú istú kostru: koreň `section.orders-section`. Tento test prejde všetky
// taby dotknuté PR A (+ vzor „Na objednanie") a overí, že zdieľaná kostra je
// prítomná, prázdny stav používa `p.empty` a načítavací indikátor `role=status`
// (keď sú zobrazené), a že konzola je počas celého prechodu čistá. Presné dáta
// sekcií pokrývajú ich vlastné spec súbory (`order-flags`/`order-merge`/
// `supplier-stock`/`riesit`) — tu overujeme len JEDNOTNÚ kostru naprieč nimi.
//
// Taby PR A a ich titulky (kreslí Topbar, žiadny vlastný `<h1>/<h2>` v sekcii):
//  - „Na objednanie" (vzor), „Riešiť", „Výmena tovaru", „Vrátený tovar",
//    „Reklamácie", „Zlúčenie objednávok" — priečinok „Eshop"/„Dôležité"
//    (rozbalené predvolene); „Dodávateľský sklad" — priečinok „Systém"
//    (štartuje ZBALENÝ, treba ho najprv rozbaliť).
const SEKCIE_ESHOP = [
  "Na objednanie",
  "Riešiť",
  "Výmena tovaru",
  "Vrátený tovar",
  "Reklamácie",
  "Zlúčenie objednávok",
] as const;

test("všetky sekcie PR A zdieľajú kostru section.orders-section, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_SHELL_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  for (const nazov of SEKCIE_ESHOP) {
    await page.getByRole("button", { name: nazov }).click();
    await expect(page.getByRole("heading", { name: nazov })).toBeVisible();
    // Zdieľaná kostra: koreň sekcie je `section.orders-section` (SectionShell).
    await expect(page.locator("section.orders-section")).toBeVisible();
  }

  // „Dodávateľský sklad" je v priečinku „Systém", ktorý štartuje zbalený —
  // najprv rozbaliť, potom otvoriť (rovnaký vzor ako `nav.spec.ts`).
  await page.getByRole("button", { name: "Systém" }).click();
  await page.getByRole("button", { name: "Dodávateľský sklad" }).click();
  await expect(page.getByRole("heading", { name: "Dodávateľský sklad" })).toBeVisible();
  await expect(page.locator("section.orders-section")).toBeVisible();
  // Dodávateľský sklad zachováva svoj pôvodný testid na koreni sekcie.
  await expect(page.getByTestId("supplier-stock-section")).toBeVisible();

  expect(chyby).toEqual([]);
});

// issue 548 (PR C): rovnaké zjednotenie kostry pre tri sekcie s vlastným
// „pomiešaným" markupom — „Objednávky predajňa" (priečinok „Eshop", rozbalený),
// „Úlohy na dnes" (priečinok „Dôležité", rozbalený) a „Úhrady" (priečinok
// „Slavosport", rozbalený — `defaultCollapsed` nenastavený). Pred adopciou
// mali holý `<section>` / `<section class="uhrady">` (nie `section.orders-section`)
// a Úhrady navyše vlastný `<h2>` v `<main>` → tento test je RED; po adopcii
// `SectionShell` (koreň) + zmene Úhrady `<h2>`→`<h3>` je GREEN. Dáta sekcií
// pokrývajú ich vlastné spec súbory (`floor-notes`/`daily-tasks`/`uhrady`) —
// tu overujeme len JEDNOTNÚ kostru + čistú konzolu.
// Všetky tri sú v priečinkoch rozbalených predvolene („Eshop"/„Dôležité"/
// „Slavosport" — žiadny `defaultCollapsed`), takže stačí kliknúť na záložku.
const SEKCIE_PR_C = ["Objednávky predajňa", "Úlohy na dnes", "Úhrady"] as const;

test("sekcie PR C zdieľajú kostru section.orders-section, žiadny vlastný h1/h2 v main, konzola čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_SHELL_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  for (const nazov of SEKCIE_PR_C) {
    await page.getByRole("button", { name: nazov }).click();
    // Titul kreslí Topbar (`<header class="topbar"><h1>`), nie sekcia.
    await expect(page.getByRole("heading", { name: nazov })).toBeVisible();
    // Zdieľaná kostra: koreň sekcie je `section.orders-section` (SectionShell).
    await expect(page.locator("section.orders-section")).toBeVisible();
    // Sekcia si nekreslí vlastný nadpis — `<main>` neobsahuje žiadny h1/h2
    // (h3 „Nahrať súbor" v Úhradách je povolený, `.claude/rules/frontend-design.md`).
    await expect(page.locator("main h1, main h2")).toHaveCount(0);
  }

  expect(chyby).toEqual([]);
});

// issue 548 (PR B): rovnaké zjednotenie kostry pre tri ďalšie sekcie —
// „Nedostupné tovary" (priečinok „Eshop", rozbalený), „Upozornenia"
// (priečinok „Dôležité", rozbalený) a „Vypredané → Skladom" (priečinok
// „Automatizácie", štartuje ZBALENÝ — najprv rozbaliť). Pre každú overí, že
// koreň je zdieľaný `section.orders-section` (SectionShell), že titul kreslí
// Topbar (žiadny vlastný `<h1>/<h2>` v `<main>`) a že konzola je počas celého
// prechodu čistá. Dáta jednotlivých sekcií pokrývajú ich vlastné spec súbory
// (`nedostupne`/`upozornenia`/`restock-*`) — tu overujeme len JEDNOTNÚ kostru.
const SEKCIE_PR_B = [
  { nazov: "Nedostupné tovary", priecinok: null },
  { nazov: "Upozornenia", priecinok: null },
  { nazov: "Vypredané → Skladom", priecinok: "Automatizácie" },
] as const;

test("sekcie PR B zdieľajú kostru section.orders-section, žiadny vlastný h1/h2 v main, konzola čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_SHELL_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  for (const { nazov, priecinok } of SEKCIE_PR_B) {
    if (priecinok !== null) await page.getByRole("button", { name: priecinok }).click();
    await page.getByRole("button", { name: nazov }).click();
    // Titul kreslí Topbar (`<header class="topbar"><h1>`), nie sekcia.
    await expect(page.getByRole("heading", { name: nazov })).toBeVisible();
    // Zdieľaná kostra: koreň sekcie je `section.orders-section` (SectionShell).
    await expect(page.locator("section.orders-section")).toBeVisible();
    // Sekcia si nekreslí vlastný nadpis — `<main>` neobsahuje žiadny h1/h2
    // (h3 v kartách je povolený, `.claude/rules/frontend-design.md`).
    await expect(page.locator("main h1, main h2")).toHaveCount(0);
  }

  expect(chyby).toEqual([]);
});

// issue 548 (PR D): posledná dávka — ostatné VIDITEĽNÉ registry taby (`nav.ts`
// NAV), ktoré si dosiaľ kreslili vlastný „pomiešaný" markup (holý `<section>`/
// `<div>`, holé „Načítavam…", `btn lg`): „Objednať DPD" + „Poznámky" (priečinok
// „Dôležité", rozbalený), „Vyhľadať" + „Párovanie" (priečinok „Eshop",
// rozbalený), „Texty e-mailov" + „Sync zo Shoptetu" (priečinok „Systém",
// štartuje ZBALENÝ) a „Odoslané e-maily" + „Nevyzdvihnuté zásielky" +
// „Pripomienky objednávok" (priečinok „Automatizácie", štartuje ZBALENÝ).
// Pred adopciou mali holý `<section>`/`<div>` (nie `section.orders-section`) →
// tento test je RED; po adopcii `SectionShell` (koreň) je GREEN. HIDDEN_TABS
// (Katalóg/Kontrola párovania/Plánovač) sú mimo rozsahu — držia si vlastný
// nadpis. Dáta sekcií pokrývajú ich vlastné spec súbory — tu len JEDNOTNÁ kostra.
const SEKCIE_PR_D = [
  "Objednať DPD",
  "Poznámky",
  "Vyhľadať",
  "Párovanie",
  "Texty e-mailov",
  "Sync zo Shoptetu",
  "Odoslané e-maily",
  "Nevyzdvihnuté zásielky",
  "Pripomienky objednávok",
] as const;

test("sekcie PR D zdieľajú kostru section.orders-section, žiadny vlastný h1/h2 v main, konzola čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_SHELL_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // „Systém" a „Automatizácie" štartujú ZBALENÉ — rozbaliť ich RAZ (opätovný
  // klik by ich zase zbalil), potom sú všetky ich záložky dosiahnuteľné priamo.
  await page.getByRole("button", { name: "Systém" }).click();
  await page.getByRole("button", { name: "Automatizácie" }).click();

  for (const nazov of SEKCIE_PR_D) {
    await page.getByRole("button", { name: nazov }).click();
    // Titul kreslí Topbar (`<header class="topbar"><h1>`), nie sekcia.
    await expect(page.getByRole("heading", { name: nazov })).toBeVisible();
    // Zdieľaná kostra: koreň sekcie je `section.orders-section` (SectionShell).
    await expect(page.locator("section.orders-section")).toBeVisible();
    // Sekcia si nekreslí vlastný nadpis — `<main>` neobsahuje žiadny h1/h2
    // (h3 podnadpisy sú povolené, `.claude/rules/frontend-design.md`).
    await expect(page.locator("main h1, main h2")).toHaveCount(0);
  }

  expect(chyby).toEqual([]);
});
