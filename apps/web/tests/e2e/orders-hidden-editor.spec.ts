import { expect, test, type ConsoleMessage } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// Vlastný, IZOLOVANÝ účet (`scripts/e2e-setup.ts`'s komentár vysvetľuje dôvod
// aj mechanizmus — balík je už na hranici `MAX_ATTEMPTS`).
const E2E_SKRYTY_EDITOR_EMAIL = "e2e-skryty-editor@forestshop.sk";

const jeOcakavane = (m: ConsoleMessage): boolean =>
  m.location().url.includes("/api/me") && m.text().includes("401");

// issue 149: riadok s otvorenou (neuloženou) úpravou odkazu na dodávateľa
// nesmie zmiznúť pri zapnutom "skryť vybavené", aj keď je riadok už
// vybavený — kým sa úprava nezavrie. Používa DODAVATEL-TEST-1's jediný
// riadok ("4859/46", stav "caka_sa" = už vybavený, `scripts/e2e-setup.ts`).
// Test len OTVÁRA/ZAVIERA edit panel, nikdy neukladá (žiadny klik na 💾) —
// nemení žiadnu zdieľanú fixtúrovú hodnotu (vrátane hardcodovaného
// `supplierUrl`, ktorý `orders.spec.ts`'s mailový/odkazový test overuje),
// takže je bezpečné bežať súbežne s ostatnými spec súbormi.
test("riadok s otvoreným editorom odkazu na dodávateľa ostáva viditeľný pri 'skryť vybavené', zmizne po zavretí editora, konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill(E2E_SKRYTY_EDITOR_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  const skupina = page.getByTestId("supplier-DODAVATEL-TEST-1");
  const riadok = skupina.locator("[data-testid^='order-line-']");
  await expect(riadok).toBeVisible();
  // issue 162: vstup na úpravu odkazu žije teraz vo VLASTNOM rozbaľovacom
  // riadku POD `riadok`om (`colSpan` cez celú tabuľku), nie ako jeho
  // potomok — nájde sa cez najbližšieho súrodenca za `riadok`om.
  const editRiadok = riadok.locator("xpath=./following-sibling::tr[1]");

  // Bez otvoreného editora "skryť vybavené" skryje CELÚ skupinu (jediný
  // riadok je vybavený, "caka_sa") — presne existujúce správanie z issue 61.
  const toggle = page.getByTestId("orders-hide-resolved-toggle");
  await toggle.click();
  await expect(skupina).not.toBeVisible();

  // Vypnúť naspäť, otvoriť edit panel odkazu na dodávateľa (toggle, NEUKLADÁ).
  await toggle.click();
  await expect(skupina).toBeVisible();
  await riadok.getByRole("button", { name: /odkaz na dodávateľa/i }).click();
  await expect(editRiadok.locator("input[type='url']")).toBeVisible();

  // Zapnúť "skryť vybavené" znova — riadok TERAZ ostáva viditeľný, lebo má
  // otvorený editor (issue 149's akceptačná podmienka).
  await toggle.click();
  await expect(skupina).toBeVisible();
  await expect(riadok).toBeVisible();
  await expect(editRiadok.locator("input[type='url']")).toBeVisible();

  // Zavretie editora (✖, bez uloženia) — riadok teraz zmizne.
  await riadok.getByRole("button", { name: /zrušiť úpravu odkazu na dodávateľa/i }).click();
  await expect(skupina).not.toBeVisible();

  expect(chyby).toEqual([]);
});
