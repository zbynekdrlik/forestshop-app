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
