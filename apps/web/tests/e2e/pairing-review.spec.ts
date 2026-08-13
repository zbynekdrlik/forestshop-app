import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// VLASTNÝ izolovaný účet (rovnaký mechanizmus ako `E2E_NAVRHY_ODKAZOV_EMAIL`,
// `.claude/rules/frontend-design.md`) — zdieľaný `e2e@forestshop.sk` je už
// na hranici `MAX_ATTEMPTS`. Musí sa zhodovať s `scripts/e2e-fixtures-
// pairing-review.ts`'s `E2E_PAROVANIE_REVIEW_EMAIL`.
const E2E_PAROVANIE_REVIEW_EMAIL = "e2e-parovanie-review@forestshop.sk";

// issue 387 E5: "Eshop → Párovanie" — VIDITEĽNÁ záložka (`nav.ts`, priečinok
// Eshop). Fixtúry (`scripts/e2e-fixtures-pairing-review.ts`): "E2E-PR-CHYBA"
// (bez efektívnej linky, MÁ navrhnutého kandidáta — "unreviewed"+"matched"),
// "E2E-PR-NENAJDENY" (bez efektívnej linky, ŽIADNY kandidát — dokazuje
// "Nenašiel sa žiadny kandidát" stav) a "E2E-PR-SLINKOU" (UŽ MÁ efektívnu
// linku — dokazuje, že predvolený "Nezrevidované" filter ho VYLÚČI, viditeľný
// len pri "Všetky"). Substring kolízia s "Párovanie produktov" (#239) —
// `{ name: "Párovanie", exact: true }` je POVINNÉ na tejto záložke, presne
// ako `nav.spec.ts`.

test("predvolený filter 'Nezrevidované' ukáže produkty bez linky (s aj bez kandidáta), vylúči produkt, čo linku už má; konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_PAROVANIE_REVIEW_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // `data-testid`, nie `getByRole` — "Párovanie" je substring-om AJ
  // "Párovanie produktov" AJ VLASTNÉHO odznakového aria-label ("Párovanie
  // Párovanie: N"), viď `nav.spec.ts`'s rovnaký komentár.
  await page.getByTestId("nav-tab-pairing-review").click();
  await expect(page.getByRole("heading", { name: "Párovanie", exact: true })).toBeVisible();

  // Napárovaný produkt — karta ukazuje náš produkt aj navrhnutého kandidáta,
  // BEZ akýchkoľvek akčných tlačidiel (E5 je len čítanie, E6 pridá rozhodovanie).
  const chybaKarta = page.getByTestId("pairing-review-card-E2E-PR-CHYBA");
  await expect(chybaKarta).toBeVisible();
  await expect(chybaKarta).toContainText("E2E Bunda Alfa Nezrevidovaná");
  await expect(page.getByTestId("pairing-review-candidate-E2E-PR-CHYBA")).toContainText("E2E Bunda Alfa u dodávateľa");
  await expect(chybaKarta.getByRole("button")).toHaveCount(0);

  // Nenapárovaný produkt (gather nenašiel u dodávateľa nič) — vlastná hláška.
  const nenajdenyKarta = page.getByTestId("pairing-review-card-E2E-PR-NENAJDENY");
  await expect(nenajdenyKarta).toBeVisible();
  await expect(page.getByTestId("pairing-review-no-candidate-E2E-PR-NENAJDENY")).toContainText("Nenašiel sa žiadny kandidát");

  // Produkt, čo UŽ MÁ efektívnu linku — "Nezrevidované" ho vylúči.
  await expect(page.getByTestId("pairing-review-card-E2E-PR-SLINKOU")).toHaveCount(0);

  // Prepnutie na "Všetky" ho odkryje — dôkaz, že filter naozaj filtruje,
  // nie že appka o produkte jednoducho nevie.
  await page.getByTestId("pairing-review-filter-all").click();
  await expect(page.getByTestId("pairing-review-card-E2E-PR-SLINKOU")).toBeVisible();

  expect(chyby).toEqual([]);
});

// issue 387 E5 (design komentár na tickete): odznak v ľavom menu = počet
// "nezrevidovaných" (bez efektívnej linky), viditeľný AJ pri nasledujúcom
// prihlásení bez otvorenia záložky (rovnaký priamy vzor ako issue 331's
// `nav-badge-restock-links`).
test("odznak v menu ukazuje počet nezrevidovaných HNEĎ po prihlásení, bez otvorenia záložky; konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_PAROVANIE_REVIEW_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // Predvolená landing obrazovka je "Na objednanie" (issue 302) — odznak
  // musí byť vidno TU. Zdieľaná globálna DB (iné spec súbory môžu bežať
  // súbežne) — over PLATNÝ tvar, nie presnú hodnotu, rovnaký princíp ako
  // `nav.spec.ts`'s `nav-badge-orders`.
  const odznak = page.getByTestId("nav-badge-pairing-review");
  await expect(odznak).toBeVisible();
  await expect(odznak).toHaveText(/^\d+$/);

  expect(chyby).toEqual([]);
});
