import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const ZLE_HESLO = "nespravne";
// #32: samostatný, IZOLOVANÝ účet len pre test zmeny hesla nižšie — musí sa
// zhodovať s `E2E_HESLO_ZMENA_EMAIL` v `scripts/e2e-setup.ts`. Ten test
// DOČASNE mení skutočné heslo prihláseného účtu v DB; keby sa prihlasoval pod
// zdieľaným `e2e@forestshop.sk` (ako zvyšné testy tu aj `catalog.spec.ts`/
// `orders.spec.ts`), súbežný `POST /api/login` z INÉHO spec súboru (Playwright
// pri `--workers=2` beží spec súbory súbežne proti JEDNÉMU API serveru + DB)
// by mohol spadnúť do okna medzi zmenou a vrátením hesla a dostať skutočný
// 401 — presne mechanizmus, ktorý spôsoboval #32.
const E2E_HESLO_ZMENA_EMAIL = "e2e-heslo@forestshop.sk";

test("manažér sa prihlási, vidí svoje meno a verziu, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  // `/api/me`, kým používateľ ešte nie je prihlásený, a dostane 401. To je očakávané
  // správanie, nie chyba — prehliadač ho zapíše ako „Failed to load resource" console
  // error. Text správy neobsahuje URL (Chromium ju necháva len v `location()`), takže
  // rozpoznávame podľa nej, nie podľa textu. Všetko ostatné v konzole je chyba a test padá.
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => chyby.push(e.message));

  // #57: "Plánovač" je od nového ľavého menu SKRYTÁ obrazovka (viditeľné sú
  // len "Sync zo Shoptetu"/"Na objednanie") — dostupná ďalej cez priamy odkaz
  // `?tab=scheduler` (`nav.ts`'s HIDDEN_TABS), presne kvôli tomuto testu.
  await page.goto("/?tab=scheduler");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByTestId("greeting")).toContainText("E2E Manažér");
  await expect(page.getByTestId("version")).toHaveText(/^v\d+\.\d+\.\d+/);

  // F2 (#12/#3): manažér vidí sekciu "Plánovač". `e2e-setup.ts` nespúšťa
  // žiaden tick (#115 pridalo LEN jeden umelo zostarnutý `job_run` riadok pre
  // katalóg, kvôli `nav.spec.ts`'s staleness testu) — tabuľka teda ukazuje
  // PRESNE tento jeden riadok, nie je prázdna, ale ani nie je "rozbitá".
  await expect(page.getByRole("heading", { name: "Plánovač" })).toBeVisible();
  await expect(page.getByTestId("job-catalog-import")).toBeVisible();

  // #57: odhlásenie žije v menu používateľa v hlavičke (klik na meno ho rozbalí).
  await page.getByTestId("greeting").click();
  await page.getByRole("button", { name: "Odhlásiť" }).click();
  await expect(page.getByRole("heading", { name: "Prihlásenie" })).toBeVisible();

  expect(chyby).toEqual([]);
});

test("zlé heslo ukáže slovenskú hlášku a nepustí ďalej", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(ZLE_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("alert")).toHaveText("Nesprávny e-mail alebo heslo");
});

// (#10) Zmena vlastného hesla. Používa DVE prihlásené "zariadenia" (dva
// samostatné browser contexty so ZDIEĽANÝM e2e používateľom) na overenie, že
// zmena hesla zruší tú DRUHÚ, staršiu reláciu, ale tú, ktorá zmenu vykonala,
// necháva bežať ďalej — presne požiadavka ticketu ("stará relácia prestane
// platiť"). Na konci sa heslo vráti na pôvodné, aby test ostal opakovateľný
// bez ohľadu na poradie behu (žiadny reset DB medzi testami v tomto súbore).
test("zmena hesla: zlé staré heslo/nezhoda odmietnuté, úspešná zmena zruší INÚ reláciu, aktuálna ostáva prihlásená", async ({
  page,
  browser,
}) => {
  const NOVE_HESLO = "e2e-nove-heslo-xyz";
  const chyby: string[] = [];
  const sledujKonzolu = (p: typeof page): void => {
    p.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
    });
    p.on("pageerror", (e) => { chyby.push(e.message); });
  };
  sledujKonzolu(page);

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_HESLO_ZMENA_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByTestId("greeting")).toContainText("E2E Manažér");

  // Druhé, nezávislé "zariadenie" — prihlásené TEN ISTÝ používateľ, PRED
  // zmenou hesla — aby sme mali reláciu, ktorá zmenu hesla nevykoná.
  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  sledujKonzolu(page2);
  await page2.goto("/");
  await page2.getByLabel("E-mail").fill(E2E_HESLO_ZMENA_EMAIL);
  await page2.getByLabel("Heslo").fill(E2E_HESLO);
  await page2.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page2.getByTestId("greeting")).toContainText("E2E Manažér");

  // #57: zmena vlastného hesla už nie je rovno na stránke — je v menu
  // používateľa v hlavičke (klik na meno ho rozbalí, žiadny priamy vzor v
  // starej appke, pozri dizajnový komentár na issue 57).
  await page.getByTestId("greeting").click();
  await page.getByRole("button", { name: "Zmeniť heslo" }).click();

  // Zlé staré heslo — odmietnuté, nič sa nezmení.
  await page.getByLabel("Staré heslo").fill(ZLE_HESLO);
  await page.getByLabel("Nové heslo", { exact: true }).fill(NOVE_HESLO);
  await page.getByLabel("Nové heslo znova").fill(NOVE_HESLO);
  await page.getByRole("button", { name: "Zmeniť heslo" }).click();
  // #115: bare `getByRole("alert")` bol na tomto mieste nejednoznačný, kým
  // bola predvolená obrazovka "Sync zo Shoptetu" (pod týmto panelom vtedy
  // svietil aj `role="alert"` staleness upozornenie, `sync-stale-Katalóg`).
  // Issue 302 zmenilo predvolenú obrazovku na "Na objednanie" — filter tu
  // ostáva zámerne (robustné bez ohľadu na to, čo je práve predvolené),
  // rovnaký vzor ako `.claude/rules/testing.md`'s existujúca kolízna
  // poznámka pri `getByLabel`u: oprava na strane KOLÍDUJÚCEHO locatora
  // (`.filter({ hasText })`), nie odobratím `role="alert"` novému prvku.
  await expect(page.getByRole("alert").filter({ hasText: "Nesprávne staré heslo" })).toHaveText(
    "Nesprávne staré heslo",
  );

  // Nezhodujúce sa potvrdenie nového hesla — odmietnuté klientom, server sa
  // vôbec nevolá.
  await page.getByLabel("Staré heslo").fill(E2E_HESLO);
  await page.getByLabel("Nové heslo", { exact: true }).fill(NOVE_HESLO);
  await page.getByLabel("Nové heslo znova").fill("ine-heslo-nez-vyssie");
  await page.getByRole("button", { name: "Zmeniť heslo" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Nové heslo a jeho potvrdenie sa nezhodujú" }),
  ).toHaveText("Nové heslo a jeho potvrdenie sa nezhodujú");

  // Úspešná zmena.
  await page.getByLabel("Staré heslo").fill(E2E_HESLO);
  await page.getByLabel("Nové heslo", { exact: true }).fill(NOVE_HESLO);
  await page.getByLabel("Nové heslo znova").fill(NOVE_HESLO);
  await page.getByRole("button", { name: "Zmeniť heslo" }).click();
  await expect(page.getByTestId("password-change-success")).toBeVisible();

  // Druhé zariadenie malo v tom čase ešte OTVORENÚ reláciu — po obnovení
  // stránky zistí, že jeho relácia je zrušená, a appka ho vráti na
  // prihlasovaciu obrazovku (skutočné správanie, ktoré uvidí používateľ).
  await page2.reload();
  await expect(page2.getByRole("heading", { name: "Prihlásenie" })).toBeVisible();

  // Prvé zariadenie (to, čo zmenu vykonalo) ostáva prihlásené aj po obnovení.
  await page.reload();
  await expect(page.getByTestId("greeting")).toContainText("E2E Manažér");

  // Obnovenie stránky zavrie menu aj panel zmeny hesla (React stav) — znova otvoriť.
  await page.getByTestId("greeting").click();
  await page.getByRole("button", { name: "Zmeniť heslo" }).click();

  // Vrátenie hesla na pôvodné — aby test ostal opakovateľný bez ohľadu na
  // poradie/opakovanie behu (žiaden reset DB medzi testami tohto súboru).
  await page.getByLabel("Staré heslo").fill(NOVE_HESLO);
  await page.getByLabel("Nové heslo", { exact: true }).fill(E2E_HESLO);
  await page.getByLabel("Nové heslo znova").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Zmeniť heslo" }).click();
  await expect(page.getByTestId("password-change-success")).toBeVisible();

  await context2.close();
  expect(chyby).toEqual([]);
});
