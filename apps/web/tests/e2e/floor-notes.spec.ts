import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_PREDAJNA_EMAIL = "e2e-predajna@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-fixtures-floor-notes.ts

// issue 410: "Eshop → Objednávky predajňa" — nahrádza Štěpánovo Discord
// vlákno. Celý tok reálnym prehliadačom: napísať zápis (rastúca textarea,
// žiadne odoslanie Enterom), vyhľadať a pripnúť produkt (rovnaká cesta ako
// "Vyhľadať"), prepnúť tri nezávislé značky, upraviť text, overiť priamu aj
// vizuálne odlíšenú náhradnú adresu produktu, odopnúť produkt, zmazať
// zápis. Konzola musí zostať čistá (`.claude/rules/testing.md`).
test("napísať zápis, pripnúť produkt (priama aj náhradná adresa), prepnúť značky, upraviť, odopnúť, zmazať — konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=floor-orders");
  await page.getByLabel("E-mail").fill(E2E_PREDAJNA_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Objednávky predajňa" })).toBeVisible();
  await expect(page.getByTestId("floor-notes-empty")).toBeVisible();

  // Rastúca textarea — Enter len pridá nový riadok, formulár sa NEODOŠLE.
  const novaTextarea = page.getByTestId("floor-note-new-input");
  await novaTextarea.fill("Matúš Dubec\n0949 647 802");
  await novaTextarea.press("Enter");
  await novaTextarea.pressSequentially("bunda Rogaland L");
  await expect(novaTextarea).toHaveValue("Matúš Dubec\n0949 647 802\nbunda Rogaland L");

  await page.getByTestId("floor-note-new-add").click();
  await expect(page.getByTestId("floor-notes-list")).toBeVisible();
  const riadok = page.locator('[data-testid^="floor-note-row-"]');
  await expect(riadok).toHaveCount(1);
  await expect(riadok).toContainText("Matúš Dubec");
  await expect(novaTextarea).toHaveValue("");

  const noteId = (await riadok.getAttribute("data-testid"))?.replace("floor-note-row-", "") ?? "";

  // Pripnúť produkt S priamou adresou — rovnaká vyhľadávacia cesta ako
  // "Eshop → Vyhľadať".
  await page.getByTestId(`floor-note-attach-toggle-${noteId}`).click();
  await page.getByTestId("floor-note-product-search-input").fill("E2E Predajňa Bunda Rogaland");
  await page.getByTestId("floor-note-product-search-submit").click();
  await expect(page.getByTestId("floor-note-product-pin-E2E-PREDAJNA-1")).toBeVisible();
  await page.getByTestId("floor-note-product-pin-E2E-PREDAJNA-1").click();

  const priamyOdkaz = page.getByTestId(`floor-note-product-link-${noteId}-E2E-PREDAJNA-1`);
  await expect(priamyOdkaz).toBeVisible();
  await expect(priamyOdkaz).toHaveAttribute("href", "https://www.forestshop.sk/e2e-predajna-bunda-rogaland/");
  await expect(priamyOdkaz).not.toHaveClass(/fallback/);

  // Pripnúť DRUHÝ produkt — BEZ priamej adresy (vizuálne odlíšený náhradný
  // odkaz, design komentár na ticket-e: nikdy plain-vyzerajúci odkaz).
  await page.getByTestId("floor-note-product-search-input").fill("E2E Predajňa Čiapka Polar");
  await page.getByTestId("floor-note-product-search-submit").click();
  await page.getByTestId("floor-note-product-pin-E2E-PREDAJNA-2").click();
  const nahradnyOdkaz = page.getByTestId(`floor-note-product-link-${noteId}-E2E-PREDAJNA-2`);
  await expect(nahradnyOdkaz).toHaveClass(/floor-note-product-link-fallback/);
  await expect(page.locator(`[data-testid="floor-note-row-${noteId}"]`)).toContainText("hľadať na eshope");

  await page.getByTestId(`floor-note-attach-toggle-${noteId}`).click(); // zavrieť hľadanie

  // Tri nezávislé značky.
  await page.getByTestId(`floor-note-marker-resolved-${noteId}`).click();
  await expect(page.getByTestId(`floor-note-marker-resolved-${noteId}`)).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId(`floor-note-marker-ordered-${noteId}`).click();
  await expect(page.getByTestId(`floor-note-marker-ordered-${noteId}`)).toHaveAttribute("aria-pressed", "true");
  // "Vybavené" NEZMIZNE, len sa vizuálne stlmí.
  await expect(page.getByTestId(`floor-note-row-${noteId}`)).toHaveClass(/floor-note-resolved/);
  await expect(riadok).toHaveCount(1);

  // Upraviť text — bez odoslania Enterom.
  await page.getByTestId(`floor-note-edit-${noteId}`).click();
  const editTextarea = page.getByTestId(`floor-note-edit-input-${noteId}`);
  await editTextarea.fill("Matúš Dubec — vybavené, čaká na vyzdvihnutie");
  await page.getByTestId(`floor-note-edit-save-${noteId}`).click();
  await expect(page.getByTestId(`floor-note-text-${noteId}`)).toHaveText("Matúš Dubec — vybavené, čaká na vyzdvihnutie");

  // Odopnúť prvý produkt.
  await page.getByTestId(`floor-note-product-detach-${noteId}-E2E-PREDAJNA-1`).click();
  await expect(page.getByTestId(`floor-note-product-link-${noteId}-E2E-PREDAJNA-1`)).toHaveCount(0);
  await expect(page.getByTestId(`floor-note-product-link-${noteId}-E2E-PREDAJNA-2`)).toBeVisible();

  // Zmazať zápis — okamžite, bez potvrdzovacieho dialógu.
  await page.getByTestId(`floor-note-delete-${noteId}`).click();
  await expect(page.getByTestId("floor-notes-empty")).toBeVisible();

  expect(chyby).toEqual([]);
});
