import { expect, test, type ConsoleMessage } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const ZLE_HESLO = "nespravne";

test("manažér sa prihlási, vidí svoje meno a verziu, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  // Jediná povolená výnimka: hneď po otvorení stránky (a po odhlásení) sa appka pýta
  // `/api/me`, kým používateľ ešte nie je prihlásený, a dostane 401. To je očakávané
  // správanie, nie chyba — prehliadač ho zapíše ako „Failed to load resource" console
  // error. Text správy neobsahuje URL (Chromium ju necháva len v `location()`), takže
  // rozpoznávame podľa nej, nie podľa textu. Všetko ostatné v konzole je chyba a test padá.
  const jeOcakavane = (m: ConsoleMessage): boolean =>
    m.location().url.includes("/api/me") && m.text().includes("401");
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => chyby.push(e.message));

  await page.goto("/");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByTestId("greeting")).toContainText("E2E Manažér");
  await expect(page.getByTestId("version")).toHaveText(/^v\d+\.\d+\.\d+/);

  // F2 (#12/#3): manažér vidí sekciu "Plánovač" — e2e-setup.ts nespúšťa žiaden
  // tick, takže `job_run` je prázdna a musí sa zobraziť informačná veta, nie
  // holá/rozbitá tabuľka.
  await expect(page.getByRole("heading", { name: "Plánovač" })).toBeVisible();
  await expect(page.getByTestId("scheduler-empty")).toHaveText("Žiadny beh zatiaľ nie je zaznamenaný.");

  await page.getByRole("button", { name: "Odhlásiť sa" }).click();
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
  const jeOcakavane = (m: ConsoleMessage): boolean =>
    m.location().url.includes("/api/me") && m.text().includes("401");
  const chyby: string[] = [];
  const sledujKonzolu = (p: typeof page): void => {
    p.on("console", (m) => {
      if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
    });
    p.on("pageerror", (e) => { chyby.push(e.message); });
  };
  sledujKonzolu(page);

  await page.goto("/");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByTestId("greeting")).toContainText("E2E Manažér");

  // Druhé, nezávislé "zariadenie" — prihlásené TEN ISTÝ používateľ, PRED
  // zmenou hesla — aby sme mali reláciu, ktorá zmenu hesla nevykoná.
  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  sledujKonzolu(page2);
  await page2.goto("/");
  await page2.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page2.getByLabel("Heslo").fill(E2E_HESLO);
  await page2.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page2.getByTestId("greeting")).toContainText("E2E Manažér");

  // Zlé staré heslo — odmietnuté, nič sa nezmení.
  await page.getByLabel("Staré heslo").fill(ZLE_HESLO);
  await page.getByLabel("Nové heslo", { exact: true }).fill(NOVE_HESLO);
  await page.getByLabel("Nové heslo znova").fill(NOVE_HESLO);
  await page.getByRole("button", { name: "Zmeniť heslo" }).click();
  await expect(page.getByRole("alert")).toHaveText("Nesprávne staré heslo");

  // Nezhodujúce sa potvrdenie nového hesla — odmietnuté klientom, server sa
  // vôbec nevolá.
  await page.getByLabel("Staré heslo").fill(E2E_HESLO);
  await page.getByLabel("Nové heslo", { exact: true }).fill(NOVE_HESLO);
  await page.getByLabel("Nové heslo znova").fill("ine-heslo-nez-vyssie");
  await page.getByRole("button", { name: "Zmeniť heslo" }).click();
  await expect(page.getByRole("alert")).toHaveText("Nové heslo a jeho potvrdenie sa nezhodujú");

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
