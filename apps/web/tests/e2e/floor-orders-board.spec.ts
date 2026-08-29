import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_PREDAJNA_EMAIL = "e2e-predajna@forestshop.sk"; // zhoda so scripts/e2e-fixtures-floor-notes.ts

// issue 480: predajňové položky (🛍️) zo zápisov „Objednávky predajňa" v board-e
// „Na objednanie". Celý tok reálnym prehliadačom: pripnúť produkt na nevybavený
// zápis → riadok sa objaví v „Na objednanie" → označiť ho ako objednaný →
// zápis dostane 🛒 automaticky → vybaviť (resolved) zápis → riadok z „Na
// objednanie" zmizne. Konzola musí zostať čistá (`.claude/rules/testing.md`).
// Znovupoužíva existujúci izolovaný účet + fixtúru E2E-PREDAJNA-1 (žiadny nový
// variant → žiadny posun `catalog.spec.ts` počtov).
test("predajňový produkt sa objaví v Na objednanie, dá sa objednať, zápis dostane 🛒, po vybavení riadok zmizne — konzola čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  // Prihlásenie + vytvorenie zápisu s pripnutým produktom (v „Objednávky predajňa").
  await page.goto("/?tab=floor-orders");
  await page.getByLabel("E-mail").fill(E2E_PREDAJNA_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Objednávky predajňa" })).toBeVisible();

  await page.getByTestId("floor-note-new-input").fill("E2E Board Zákazník");
  await page.getByTestId("floor-note-new-add").click();
  await expect(page.getByTestId("floor-notes-list")).toBeVisible();
  const riadokZapisu = page.locator('[data-testid^="floor-note-row-"]').filter({ hasText: "E2E Board Zákazník" });
  await expect(riadokZapisu).toHaveCount(1);
  const noteId = (await riadokZapisu.getAttribute("data-testid"))?.replace("floor-note-row-", "") ?? "";
  expect(noteId).not.toBe("");

  await page.getByTestId(`floor-note-attach-toggle-${noteId}`).click();
  await page.getByTestId("floor-note-product-search-input").fill("E2E Predajňa Bunda Rogaland");
  await page.getByTestId("floor-note-product-search-submit").click();
  await page.getByTestId("floor-note-product-pin-E2E-PREDAJNA-1").click();
  await expect(page.getByTestId(`floor-note-product-link-${noteId}-E2E-PREDAJNA-1`)).toBeVisible();

  // „Na objednanie" — pripnutý produkt sa objaví ako predajňový riadok.
  await page.goto("/?tab=orders");
  const boardRow = page.getByTestId(`floor-order-row-${noteId}-E2E-PREDAJNA-1`);
  await expect(boardRow).toBeVisible();
  await expect(boardRow).toContainText("E2E Board Zákazník");
  await expect(boardRow).toContainText("E2E-PREDAJNA-1");
  // 🛍️ odkaz na mieste čísla objednávky vedie na zápis v „Objednávky predajňa".
  await expect(page.getByTestId(`floor-order-link-${noteId}-E2E-PREDAJNA-1`)).toHaveAttribute("href", "?tab=floor-orders");

  // Označiť predajňový riadok ako objednaný. issue 521: `.click()` + neskoršie
  // `expect().toBeChecked()`, NIKDY `.check()` — checkboxov `onChange` robí ASYNC
  // serverový zápis a `.check()` si stav overí OKAMŽITE po kliku, takže pod
  // 2-worker CI záťažou prehrá závod s optimistickým update-om ("Clicking the
  // checkbox did not change its state"). Zdokumentovaný vzor `.claude/rules/testing.md`
  // (issue 60) — `toBeChecked()` nižšie auto-retryuje, kým sa zápis potvrdí.
  const checkbox = page.getByTestId(`floor-ordered-checkbox-${noteId}-E2E-PREDAJNA-1`);
  await expect(checkbox).not.toBeChecked();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(boardRow).toHaveClass(/ordered/);

  // Zápis má jediný produkt a ten je teraz objednaný → 🛒 sa nastavilo automaticky.
  await page.goto("/?tab=floor-orders");
  await expect(page.getByTestId(`floor-note-marker-ordered-${noteId}`)).toHaveAttribute("aria-pressed", "true");

  // Vybaviť (resolved) zápis → jeho predajňový riadok z „Na objednanie" zmizne.
  await page.getByTestId(`floor-note-marker-resolved-${noteId}`).click();
  await expect(page.getByTestId(`floor-note-marker-resolved-${noteId}`)).toHaveAttribute("aria-pressed", "true");

  await page.goto("/?tab=orders");
  await expect(page.getByTestId(`floor-order-row-${noteId}-E2E-PREDAJNA-1`)).toHaveCount(0);

  // Upratať — zmazať testovací zápis, nech neostáva v zdieľanej e2e DB.
  await page.goto("/?tab=floor-orders");
  await page.getByTestId(`floor-note-delete-${noteId}`).click();
  await expect(page.getByTestId(`floor-note-row-${noteId}`)).toHaveCount(0);

  expect(chyby).toEqual([]);
});
