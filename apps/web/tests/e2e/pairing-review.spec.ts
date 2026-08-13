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
// len pri "Všetky"). Táto záložka má VLASTNÝ odznakový aria-label ("Párovanie
// Párovanie: N"), ktorý kolíduje s jej vlastným accessible name — preto
// `data-testid` na tlačidle nav-tab (`nav.spec.ts`'s rovnaký komentár), a
// `{ name: "Párovanie", exact: true }` na jej `<h1>` nadpise.
//
// issue 387 E6: pridáva rozhodovanie — "E2E-PR-CHYBA" (má kandidáta) a
// "E2E-PR-NENAJDENY" (nemá kandidáta, panel je hneď otvorený) sú fixtúry E5,
// zámerne dovtedy NEROZHODNUTÉ, aby E6 testy mali čerstvý "nezrevidovaný"
// stav na začiatku behu (fixtúrový súbor sa medzi behmi znova naseeduje).

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

  // `data-testid`, nie `getByRole` — "Párovanie" je substring-om VLASTNÉHO
  // odznakového aria-label ("Párovanie Párovanie: N"), viď `nav.spec.ts`'s
  // rovnaký komentár.
  await page.getByTestId("nav-tab-pairing-review").click();
  await expect(page.getByRole("heading", { name: "Párovanie", exact: true })).toBeVisible();

  // Napárovaný produkt — karta ukazuje náš produkt aj navrhnutého kandidáta,
  // s presne DVOMA akčnými tlačidlami (✓ Dobré / ✗ Zlé, issue 387 E6 —
  // fixtúrový účet má rolu "manazer", teda smie rozhodovať).
  const chybaKarta = page.getByTestId("pairing-review-card-E2E-PR-CHYBA");
  await expect(chybaKarta).toBeVisible();
  await expect(chybaKarta).toContainText("E2E Bunda Alfa Nezrevidovaná");
  await expect(page.getByTestId("pairing-review-candidate-E2E-PR-CHYBA")).toContainText("E2E Bunda Alfa u dodávateľa");
  await expect(chybaKarta.getByTestId("pairing-review-good-E2E-PR-CHYBA")).toBeVisible();
  await expect(chybaKarta.getByTestId("pairing-review-open-panel-E2E-PR-CHYBA")).toBeVisible();

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
// pôvodný `nav-badge-restock-links`, odstránený issue 387 E8).
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

// issue 387 E6 — "✓ Dobré": karta vypadne z predvoleného "Nezrevidované"
// filtra (presne "unreviewed" definícia — bez efektívnej linky), dostane
// odznak "✓ Dobré" pod filtrom "Všetky", A efektívny odkaz sa OKAMŽITE
// prejaví aj na obrazovke "Vyhľadať" (#240) — obe čítajú TÚ ISTÚ
// `product_supplier_link_override` tabuľku, zdieľaný zápis
// (`.claude/rules/product-links.md`). Pôvodne toto krížové overenie
// išlo cez sesterskú obrazovku "Párovanie produktov" (#239) — issue 400
// (E9) ju odstránilo (majiteľ ju výslovne schválil na odstránenie),
// `/api/product-links` route aj jej zapisovacia cesta ostali nedotknuté.
test("'✓ Dobré' rozhodnutie zapíše efektívny odkaz — viditeľný na tejto AJ na 'Vyhľadať' obrazovke; konzola je čistá", async ({ page }) => {
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
  await page.getByTestId("nav-tab-pairing-review").click();

  const karta = page.getByTestId("pairing-review-card-E2E-PR-CHYBA");
  await expect(karta).toBeVisible();
  await karta.getByTestId("pairing-review-good-E2E-PR-CHYBA").click();

  // Predvolený filter "Nezrevidované" (bez efektívnej linky) kartu vylúči
  // hneď, ako appka potvrdí zápis — priama proxy pre "efektívny odkaz sa
  // zmenil" (rovnaký princíp ako integračný test `.claude/rules/pairing-
  // search.md`'s "unreviewed = bez efektívnej linky").
  await expect(karta).toHaveCount(0);

  await page.getByTestId("pairing-review-filter-all").click();
  const kartaVsetky = page.getByTestId("pairing-review-card-E2E-PR-CHYBA");
  await expect(kartaVsetky).toBeVisible();
  await expect(kartaVsetky.getByTestId("pairing-review-decision-badge-E2E-PR-CHYBA")).toHaveText("✓ Dobré");

  // Krížové overenie na "Vyhľadať" (#240) — zdieľaná zapisovacia cesta,
  // rovnaký vzor ako `search.spec.ts`'s "Hľadať produkt".
  await page.getByRole("button", { name: "Vyhľadať" }).click();
  await page.getByLabel("Produkt").fill("E2E-PR-CHYBA");
  await page.getByRole("button", { name: "Hľadať produkt" }).click();
  await page.getByTestId("search-product-open-E2E-PR-CHYBA").click();
  await expect(page.getByTestId("search-detail-link-value")).toHaveText("https://e2e-dodavatel.example.com/bunda-alfa-navrh");

  expect(chyby).toEqual([]);
});

// issue 387 E6 — "📦 Nie je skladom" (terminálny stav bez odkazu) + "↩
// Vrátiť": produkt vypadne z "Nezrevidované" (je zrevidovaný, aj bez
// efektívnej linky — E5's forward-kompat poznámka), Vrátiť ho vráti späť.
test("'📦 Nie je skladom' vyradí produkt z 'Nezrevidované'; '↩ Vrátiť' ho vráti späť; konzola je čistá", async ({ page }) => {
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
  await page.getByTestId("nav-tab-pairing-review").click();

  // "E2E-PR-NENAJDENY" nemá kandidáta — panel (📦/🚫/manuál) je vidno PRIAMO,
  // bez ✓/✗ prepínača (nič na "prijatie").
  const karta = page.getByTestId("pairing-review-card-E2E-PR-NENAJDENY");
  await expect(karta).toBeVisible();
  await karta.getByTestId("pairing-review-unavailable-E2E-PR-NENAJDENY").click();
  await expect(karta).toHaveCount(0);

  await page.getByTestId("pairing-review-filter-all").click();
  const kartaVsetky = page.getByTestId("pairing-review-card-E2E-PR-NENAJDENY");
  await expect(kartaVsetky).toBeVisible();
  await expect(kartaVsetky.getByTestId("pairing-review-decision-badge-E2E-PR-NENAJDENY")).toHaveText("📦 Nie je skladom");
  await kartaVsetky.getByTestId("pairing-review-revert-E2E-PR-NENAJDENY").click();

  await page.getByTestId("pairing-review-filter-unreviewed").click();
  await expect(page.getByTestId("pairing-review-card-E2E-PR-NENAJDENY")).toBeVisible();

  expect(chyby).toEqual([]);
});
