import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // testovacie údaje, existujú len v testovacej databáze
// Musí sa zhodovať s hodnotou v `scripts/e2e-fixtures-pairing-review.ts` —
// zdieľaný izolovaný účet s `pairing-review.spec.ts` (rovnaká obrazovka,
// vyčlenené do VLASTNÉHO súboru len kvôli `.claude/rules/testing.md`'s
// `max-lines: 400` splitu, nie kvôli inému fixtúrovému balíku).
const E2E_PAROVANIE_REVIEW_EMAIL = "e2e-parovanie-review@forestshop.sk";

// issue 399 — "✂ Rozdeliť na veľkosti" (per-veľkosť linky, `pairing_variant_link`,
// nová `pairing_decision.status = 'split'`) + "Hľadať / opraviť" pod-záložka
// (jednoproduktová karta pre AKÝKOĽVEK produkt, `GET /api/pairing-review/:productKey`).
// Fixtúra: "E2E-PR-SPLIT" (2 varianty S/M, jeden navrhnutý kandidát) —
// jediný viacveľkostný produkt v `scripts/e2e-fixtures-pairing-review.ts`.

async function login(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_PAROVANIE_REVIEW_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await page.getByTestId("nav-tab-pairing-review").click();
}

// issue 399 — POZOR na PORADIE v tomto súbore: OBA split testy zdieľajú
// TEN ISTÝ fixtúrový produkt "E2E-PR-SPLIT" a `scripts/e2e-setup.ts` sa
// seeduje LEN RAZ pri štarte `webServer`u (nie pred KAŽDÝM testom) —
// zmeny jedného testu preto PRETRVÁVAJÚ do ďalšieho v tom istom súbore
// (`.claude/rules/testing.md`'s "dva testy v jednom súbore bežia
// sekvenčne, zdieľané dáta"). Tento test beží PRVÝ a KONČÍ s
// `decision === null` (revert na konci) — nasledujúci test tak nájde
// split TRIGGER tlačidlo (zobrazí sa len keď `decision === null`), nie
// panel už otvorený od predošlého testu.
test("✂ Rozdeliť na veľkosti: 'Hotovo' s CHÝBAJÚCIM linkom pre jednu veľkosť sa OPÝTA (confirm) — po potvrdení sa split aj tak odošle; '↩ Zrušiť rozdelenie' vráti do Nezrevidované, per-veľkosť linky PREŽIJÚ", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });
  page.on("dialog", (d) => {
    void d.accept();
  });

  await login(page);
  // "Všetky" HNEĎ na začiatku — split/revert prechody menia, či
  // "Nezrevidované" produkt zahŕňa; "Všetky" ho drží viditeľný počas celého testu.
  await page.getByTestId("pairing-review-filter-all").click();

  const karta = page.getByTestId("pairing-review-card-E2E-PR-SPLIT");
  await karta.getByTestId("pairing-review-split-E2E-PR-SPLIT").click();
  const panel = page.getByTestId("pairing-review-split-panel-E2E-PR-SPLIT");

  // Len veľkosť S dostane link — M ostáva zámerne PRÁZDNA.
  await panel.getByTestId("pairing-review-split-input-E2E-PR-SPLIT/S").fill("https://e2e-dodavatel.example.com/len-s");
  await panel.getByTestId("pairing-review-split-save-E2E-PR-SPLIT/S").click();
  await expect(panel.getByTestId("pairing-review-split-state-E2E-PR-SPLIT/S")).toHaveText("✓ link nastavený");

  await panel.getByTestId("pairing-review-split-done-E2E-PR-SPLIT").click();
  // Dialóg bol AUTOMATICKY prijatý (`page.on("dialog")` vyššie) — split sa
  // napriek chýbajúcej veľkosti M odoslal.
  await expect(page.getByTestId("pairing-review-decision-badge-E2E-PR-SPLIT")).toHaveText("✂ Rozdelené na veľkosti");

  // "↩ Zrušiť rozdelenie" — decision zmizne, PER-VEĽKOSŤ linky prežijú.
  await page.getByTestId("pairing-review-split-cancel-E2E-PR-SPLIT").click();
  await expect(page.getByTestId("pairing-review-decision-badge-E2E-PR-SPLIT")).toHaveCount(0);
  // Karta ostáva viditeľná ("Všetky"), aj keď decision zmizol — krížové
  // overenie, že sa naozaj vrátil do "Nezrevidované".
  await page.getByTestId("pairing-review-filter-unreviewed").click();
  await expect(page.getByTestId("pairing-review-card-E2E-PR-SPLIT")).toBeVisible();

  // Znovu otvor split — veľkosť S má SVOJ predtým uložený link, nikdy sa nestratil.
  await page.getByTestId("pairing-review-card-E2E-PR-SPLIT").getByTestId("pairing-review-split-E2E-PR-SPLIT").click();
  await expect(page.getByTestId("pairing-review-split-state-E2E-PR-SPLIT/S")).toHaveText("✓ link nastavený");
  // Zavri panel bez rozhodnutia (žiadny explicitný "Zrušiť" tlačidlo pre
  // TRANSIENTNE otvorený — bez uloženej "split" decision — panel; navigácia
  // preč z obrazovky v `afterEach`-like zmysle nie je potrebná, ĎALŠÍ test
  // si filter/kartu nájde nanovo). `decision` zostáva `null` (revert vyššie).

  expect(chyby).toEqual([]);
});

// Tento test beží DRUHÝ (viď poznámka vyššie) — nájde "E2E-PR-SPLIT" so
// `decision === null` (predošlý test skončil revertom), takže split
// TRIGGER tlačidlo je dostupné. Explicitne PREPÍŠE OBE veľkosti vlastnými
// hodnotami (nezávisle od toho, čo tam nechal predošlý test).
test("✂ Rozdeliť na veľkosti: nastavenie linku pre KAŽDÚ veľkosť (kandidát + ručne) → '✓ Hotovo' bez varovania (obe majú link) → odznak + vypadne z Nezrevidované; konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await login(page);
  // "Všetky" HNEĎ na začiatku — po "✓ Hotovo" `onDecided()` znova načíta
  // AKTUÁLNY filter (rovnaký vzor ako `pairing-review.spec.ts`'s ostatné
  // rozhodovacie testy); predvolené "Nezrevidované" by kartu po split
  // rozhodnutí VYRADILO (split je zrevidovaný), takže by zmizla zo stránky
  // skôr, než sa dá overiť odznak. "Všetky" ju drží viditeľnú počas celého testu.
  await page.getByTestId("pairing-review-filter-all").click();

  const karta = page.getByTestId("pairing-review-card-E2E-PR-SPLIT");
  await expect(karta).toBeVisible();
  await expect(karta.getByTestId("pairing-review-split-E2E-PR-SPLIT")).toBeVisible();

  await karta.getByTestId("pairing-review-split-E2E-PR-SPLIT").click();
  const panel = page.getByTestId("pairing-review-split-panel-E2E-PR-SPLIT");
  await expect(panel).toBeVisible();
  // Kandidátov panel A hlavný "Navrhnutý kandidát" blok karty zmizli.
  await expect(page.getByTestId("pairing-review-candidate-E2E-PR-SPLIT")).toHaveCount(0);

  // Veľkosť S — quick-pick z navrhnutého kandidáta.
  await expect(panel.getByTestId("pairing-review-split-row-E2E-PR-SPLIT/S")).toBeVisible();
  await panel.getByTestId("pairing-review-split-row-E2E-PR-SPLIT/S").getByRole("button", { name: /Vybrať:/ }).click();
  await expect(panel.getByTestId("pairing-review-split-state-E2E-PR-SPLIT/S")).toHaveText("✓ link nastavený");

  // Veľkosť M — ručne vpísaná URL.
  await panel.getByTestId("pairing-review-split-input-E2E-PR-SPLIT/M").fill("https://e2e-dodavatel.example.com/bunda-gama-m");
  await panel.getByTestId("pairing-review-split-save-E2E-PR-SPLIT/M").click();
  await expect(panel.getByTestId("pairing-review-split-state-E2E-PR-SPLIT/M")).toHaveText("✓ link nastavený");

  // Obe veľkosti majú link → "✓ Hotovo" sa odošle BEZ potvrdzovacej otázky.
  await panel.getByTestId("pairing-review-split-done-E2E-PR-SPLIT").click();

  await expect(page.getByTestId("pairing-review-decision-badge-E2E-PR-SPLIT")).toHaveText("✂ Rozdelené na veľkosti");
  // Krížové overenie "zrevidovaný": "Nezrevidované" ho VYRADÍ.
  await page.getByTestId("pairing-review-filter-unreviewed").click();
  await expect(page.getByTestId("pairing-review-card-E2E-PR-SPLIT")).toHaveCount(0);

  expect(chyby).toEqual([]);
});

// issue 399 — "Hľadať / opraviť": nájde produkt MIMO dnešnej "Nezrevidované"
// populácie (E2E-PR-SLINKOU už má efektívnu linku z internalNote) a otvorí
// jeho kartu cez ZDIEĽANÝ jednoproduktový endpoint — presne akceptačný
// prípad ("funguje aj pre produkty, čo už nejaký odkaz majú").
test("Hľadať / opraviť: nájde produkt podľa mena, otvorí zdieľanú kartu, '↩ Vrátiť' funguje presne ako na Prehľade; konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await login(page);

  await page.getByTestId("pairing-review-tab-hladat").click();
  await expect(page.getByTestId("pairing-search-fix")).toBeVisible();

  await page.getByLabel("Kód, názov alebo dodávateľ").fill("E2E Produkt Už S Linkou");
  // `exact: true` — bare "Hľadať" by substring-om (case-insensitive) zasiahol
  // AJ sidebarov "Vyhľadať" tab, AJ TÚTO obrazovkinu vlastnú "Hľadať /
  // opraviť" pod-záložku (`.claude/rules/testing.md`'s zdokumentovaná
  // trieda kolízie — rovnaký vzor ako `catalog.spec.ts`).
  await page.getByRole("button", { name: "Hľadať", exact: true }).click();

  await expect(page.getByTestId("pairing-search-fix-row-E2E-PR-SLINKOU")).toBeVisible();
  await page.getByTestId("pairing-search-fix-open-E2E-PR-SLINKOU").click();

  const karta = page.getByTestId("pairing-review-card-E2E-PR-SLINKOU");
  await expect(karta).toBeVisible();
  await expect(karta).toContainText("E2E Produkt Už S Linkou");

  // Bez rozhodnutia + bez kandidáta (`pairing-review.spec.ts`'s fixtúra:
  // E2E-PR-SLINKOU má `chosenUrl: null`) → panel (manuál/terminál) je vidno
  // priamo — presne to isté správanie ako na "Prehľad".
  await expect(karta.getByTestId("pairing-review-manual-input-E2E-PR-SLINKOU")).toBeVisible();

  await page.getByTestId("pairing-search-fix-back").click();
  await expect(page.getByTestId("pairing-search-fix-row-E2E-PR-SLINKOU")).toBeVisible();

  expect(chyby).toEqual([]);
});
