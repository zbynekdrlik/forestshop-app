import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze

// issue 254: VLASTNÝ izolovaný účet (rovnaký mechanizmus ako v
// `pairing.spec.ts` — balík `e2e@forestshop.sk` je UŽ na hranici
// `MAX_ATTEMPTS`), rola "manazer" pokrýva `IMPORT_ROLES`.
const E2E_RACE_EMAIL = "e2e-race@forestshop.sk";

// `GET /api/me` s odpoveďou 401 hneď po otvorení stránky. Rozpoznáva sa podľa
// `location().url`, nie podľa textu — Chromium URL do textu „Failed to load
// resource" nedáva. Rozširovanie výnimky na ďalšie cesty je zakázané.

// #57: "Katalóg" je od nového ľavého menu SKRYTÁ obrazovka (viditeľné sú len
// "Sync zo Shoptetu"/"Na objednanie") — kód aj testy ostávajú, dostupná ďalej
// cez priamy odkaz `?tab=catalog` (`nav.ts`'s HIDDEN_TABS).

test("manažér vidí stav katalógu, vyhľadá variant a konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=catalog");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // 43 = 35 riadkov fixtúry + 2 seedované kandidáty na prepnutie ("PREP-1",
  // issue 217; "PREP-2", issue 226 — rozpor voči feedu, `scripts/e2e-setup.ts`)
  // + 2 seedované produkty pre "Párovanie produktov" ("E2E-PL-CHYBA"/
  // "E2E-PL-OPRAVA", issue 239, `scripts/e2e-fixtures-product-links.ts`)
  // + 1 seedovaný produkt pre "Vyhľadať" ("E2E-SEARCH-1", issue 240,
  // `scripts/e2e-fixtures-search.ts`)
  // + 60 seedovaných produktov pre "Načítať ďalšie" (issue 337, "E2E-PAGE-
  // 001".."E2E-PAGE-060", `scripts/e2e-fixtures-pagination.ts`)
  // + 3 seedované produkty pre "Eshop → Párovanie" ("E2E-PR-CHYBA"/
  // "E2E-PR-NENAJDENY"/"E2E-PR-SLINKOU", issue 387 E5,
  // `scripts/e2e-fixtures-pairing-review.ts` — chýbalo tu pri E5, doplnené
  // issue 387 E6 pri prvom behu CELEJ e2e sady proti tomuto fixtúrovému
  // súboru) + 2 ĎALŠIE seedované produkty pre TÚ ISTÚ obrazovku (issue
  // 398/401: "E2E-PR-BEZADAPTERA" — dodávateľ bez adaptéra, "E2E-PR-PANEL"
  // — druhý/alternatívny kandidát s vlastným obrázkom v paneli) + 2
  // seedované produkty pre "Objednávky predajňa" ("E2E-PREDAJNA-1"/
  // "E2E-PREDAJNA-2", issue 410, `scripts/e2e-fixtures-floor-notes.ts`)
  // + 2 ĎALŠIE seedované VARIANTY pre "Párovanie → ✂ Rozdeliť na veľkosti"
  // (issue 399: "E2E-PR-SPLIT/S"+"E2E-PR-SPLIT/M", DVA varianty JEDNÉHO
  // produktu — jediný viacveľkostný fixtúrový produkt v tomto súbore)
  // = 109. (issue 311's 3 seedované produkty "E2E-RL-*" — issue 387 E8 ich
  // fixtúru odstránilo spolu s celou obrazovkou "Vypredané → Skladom:
  // návrhy odkazov" — z tohto súčtu preto vypadli, pôvodný súčet bol 106.)
  // Prví dvaja (PREP-1/PREP-2) sú `out_of_stock` (nemenia "sellable"/
  // "missing" nižšie), zvyšných 5, všetkých 60 "E2E-PAGE-*", všetkých 5
  // "E2E-PR-*", oba "E2E-PREDAJNA-*" a OBA "E2E-PR-SPLIT/*" varianty sú
  // `sellable` (posúvajú filter "sellable" 7→79 nižšie), "missing"(1) sa
  // nemení ani jedným z nich.
  await expect(page.getByTestId("snapshot")).toContainText("Posledný import: prijatý");
  await expect(page.getByTestId("counts")).toContainText("Variantov v katalógu (vrátane chýbajúcich): 109");
  await expect(page.getByTestId("total")).toHaveText("Nájdených: 109 (zobrazených prvých 50)");

  await page.getByLabel("Kód alebo názov").fill("40237/3XL");
  await page.getByRole("button", { name: "Hľadať", exact: true }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 1");
  const riadok = page.getByTestId("variant-40237/3XL");
  await expect(riadok).toContainText("Nohavice FOREST 1003");
  await expect(riadok).toContainText("Predaj skončil");
  await expect(riadok).toContainText("62.76 EUR");

  expect(chyby).toEqual([]);
});

test("filter podľa stavu zúži zoznam na predajné varianty", async ({ page }) => {
  await page.goto("/?tab=catalog");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 109 (zobrazených prvých 50)");
  await page.getByLabel("Stav", { exact: true }).selectOption("sellable");
  await page.getByRole("button", { name: "Hľadať", exact: true }).click();

  // 79 = 7 od issue 219 (variant "40237/L" má oba texty dostupnosti prázdne,
  // čo znamená predvolenú dostupnosť Shoptetu — "Skladom", nie vypredané) +
  // 2 sellable produkty issue 239's fixtúry ("E2E-PL-CHYBA"/"E2E-PL-OPRAVA")
  // + 1 sellable produkt issue 240's fixtúry ("E2E-SEARCH-1") + 60 sellable
  // produktov issue 337's fixtúry ("E2E-PAGE-001".."E2E-PAGE-060") + 5
  // sellable produkty issue 387/398/401's fixtúry ("E2E-PR-CHYBA"/
  // "E2E-PR-NENAJDENY"/"E2E-PR-SLINKOU"/"E2E-PR-BEZADAPTERA"/"E2E-PR-PANEL")
  // + 2 sellable produkty issue 410's fixtúry ("E2E-PREDAJNA-1"/
  // "E2E-PREDAJNA-2") + 2 sellable VARIANTY issue 399's fixtúry
  // ("E2E-PR-SPLIT/S"/"E2E-PR-SPLIT/M"). (issue 311's 2 sellable
  // "E2E-RL-NAVRH"/"E2E-RL-CUDZI" vypadli skôr — issue 387 E8 fixtúru
  // odstránilo, vtedajší súčet bol 75 — a 4 nové produkty (2 issue 398/401
  // + 2 issue 410) vyššie súčet zdvihli o 4, na 77; issue 399's 2 varianty
  // ho zdvihli o ďalšie 2, na 79.)
  await expect(page.getByTestId("total")).toHaveText("Nájdených: 79 (zobrazených prvých 50)");
  await expect(page.getByTestId("variant-40237/M")).toBeVisible();
});

// Review final-wave-a, položka 6: `scripts/e2e-setup.ts` označí variant
// "40287" priamo v databáze ako chýbajúci (presne jeden zo 7 "sellable").
test("filter 'Chýbajúce' nájde presne označený variant a riadok ukazuje, odkedy chýba", async ({ page }) => {
  await page.goto("/?tab=catalog");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 109 (zobrazených prvých 50)");
  await page.getByLabel("Stav", { exact: true }).selectOption("missing");
  await page.getByRole("button", { name: "Hľadať", exact: true }).click();

  await expect(page.getByTestId("total")).toHaveText("Nájdených: 1");
  const riadok = page.getByTestId("variant-40287");
  await expect(riadok).toBeVisible();
  await expect(riadok).toContainText("chýba od");
});

// issue 254 (súrodenec issue 251): `runIngest`'s `.then()` volalo
// `search(query, state)` PRIAMO z uzáveru vykresľovacej inštancie zafixovanej
// na klik na "Stiahnuť a naimportovať export". Reprodukcia NEMÔŽE nechať
// požiadavku doletieť na SKUTOČNÝ server ako `pairing.spec.ts`/`supplier-
// links.spec.ts` (len oneskorenú) — `SHOPTET_EXPORT_URL` nie je v E2E
// prostredí nastavené (`.claude/rules/catalog.md`), takže reálny
// `POST /api/catalog/ingest` vždy vráti 503 a `runIngest` by skončil v
// `.catch()`, ktorý `search()` vôbec nevolá (chyba, nie race). Namiesto toho
// FALOŠNÁ (nie reálna sieťová) oneskorená úspešná odpoveď — rovnaký
// zaužívaný vzor ako `orders-write-failures.spec.ts`'s fake `Response`
// (simuluje výsledok BEZ reálneho zápisu/zavolania servera, `.claude/rules/
// testing.md`), len s pridaným `setTimeout` oneskorením.
test("import (ešte prebiehajúci) nesmie prepísať MEDZITÝM zmenený filter zastaraným výsledkom (issue 254)", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.addInitScript(() => {
    const puvodny = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST" && url.includes("/api/catalog/ingest")) {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(
              new Response(JSON.stringify({ status: "duplicate", snapshotId: "e2e-issue-254-fake" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }, 400);
        });
      }
      return puvodny(input, init);
    };
  });

  await page.goto("/?tab=catalog");
  await page.getByLabel("E-mail").fill(E2E_RACE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByTestId("total")).toHaveText("Nájdených: 109 (zobrazených prvých 50)");

  await page.getByRole("button", { name: "Stiahnuť a naimportovať export" }).click();

  // ZÁMERNE bez čakania na odpoveď — filter sa mení HNEĎ po kliknutí na
  // import, presne to poradie udalostí, ktoré pôvodný bug reprodukovalo.
  await page.getByLabel("Kód alebo názov").fill("40287");
  await page.getByRole("button", { name: "Hľadať", exact: true }).click();

  // `window.fetch` je tu ÚPLNE nahradené (falošná odpoveď, viď komentár
  // vyššie) — nikdy neprejde cez skutočnú sieťovú vrstvu prehliadača, takže
  // `page.waitForResponse` (počúva CDP sieťové udalosti) by naň nikdy
  // nezareagovalo. Čaká sa preto priamym `waitForTimeout` (400ms oneskorenie
  // + rezerva na `.then()`/render reťazec).
  await page.waitForTimeout(700);

  // S opravou: `runIngest`'s `.then()` číta AKTUÁLNY filter cez ref, takže
  // jeho neskoro doručený výsledok žiada PRESNE ten istý filter ("40287"),
  // aký použil aj testov vlastný dopyt. BEZ opravy by zastaraný `.then()`
  // (uzáver s query="", state="all" z okamihu kliknutia na import) prepísal
  // zoznam CELÝM (nefiltrovaným) výpisom.
  await expect(page.getByTestId("total")).toHaveText("Nájdených: 1");
  await expect(page.getByTestId("variant-40287")).toBeVisible();

  expect(chyby).toEqual([]);
});
