import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// VLASTNÝ izolovaný účet (rovnaký mechanizmus ako `E2E_PAROVANIE_EMAIL`,
// `.claude/rules/frontend-design.md`) — zdieľaný `e2e@forestshop.sk` je už
// na hranici `MAX_ATTEMPTS`. Musí sa zhodovať s `scripts/e2e-fixtures-
// restock-links.ts`'s `E2E_NAVRHY_ODKAZOV_EMAIL`.
const E2E_NAVRHY_ODKAZOV_EMAIL = "e2e-navrhy-odkazov@forestshop.sk";

// issue 311: "Vypredané → Skladom: návrhy odkazov" — VIDITEĽNÁ záložka
// (`nav.ts`, priečinok Automatizácie). Fixtúry (`scripts/e2e-fixtures-
// restock-links.ts`): "E2E-RL-CHYBA" (vypredaný, viditeľný, BEZ linky —
// má sa zobraziť s návrhom), "E2E-RL-NAVRH" (rovnaký dodávateľ + prekryv
// mena "Bunda Alfa" — zdroj návrhu, UŽ MÁ linku) a "E2E-RL-CUDZI" (cudzí
// dodávateľ, žiadny prekryv mena — dokazuje, že sa NIKDY nenavrhne bez
// zhody). Potvrdenie ide cez ROVNAKÚ `product_supplier_link_override`
// tabuľku ako "Párovanie produktov" (#239) — druhá polovica testu to
// overuje NA TEJ DRUHEJ obrazovke, dôkaz zdieľanej zápisovej cesty.

test("vypredaný produkt bez linky ponúkne návrh podľa zhody mena + dodávateľa, potvrdenie sa zapíše a zdieľa sa s Párovaním produktov; konzola je čistá", async ({
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
  await page.getByLabel("E-mail").fill(E2E_NAVRHY_ODKAZOV_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await page.getByRole("button", { name: "Vypredané → Skladom: návrhy odkazov" }).click();
  await expect(page.getByRole("heading", { name: "Vypredané → Skladom: návrhy odkazov" })).toBeVisible();

  await page.getByLabel("Hľadať produkt (kód alebo názov)").fill("E2E-RL-CHYBA");
  await page.getByRole("button", { name: "Zobraziť" }).click();

  const riadok = page.getByTestId("restock-link-row-E2E-RL-CHYBA");
  await expect(riadok).toBeVisible();
  await expect(riadok).toContainText("E2E Bunda Alfa Vypredaná");

  // Návrh (kandidát z rovnakého dodávateľa + prekrývajúceho sa mena) je
  // VIDITEĽNÝ, ale NIČ sa nikdy neuloží samo — len klik na "Použiť" ho
  // predvyplní do vstupu.
  const navrhTlacidlo = riadok.getByTestId("restock-link-use-candidate-E2E-RL-CHYBA-E2E-RL-NAVRH");
  await expect(navrhTlacidlo).toContainText("https://e2e-dodavatel.example.com/bunda-alfa-navrh");
  // Nesúvisiaci produkt sa v návrhu NIKDY neobjaví.
  await expect(riadok).not.toContainText("E2E Šál Zeta Cudzí");

  await navrhTlacidlo.click();
  const vstup = page.getByTestId("restock-link-edit-input-E2E-RL-CHYBA");
  await expect(vstup).toHaveValue("https://e2e-dodavatel.example.com/bunda-alfa-navrh");

  await page.getByTestId("restock-link-save-E2E-RL-CHYBA").click();

  // Produkt teraz MÁ linku — táto obrazovka zobrazuje LEN produkty BEZ nej,
  // takže po uložení riadok zmizne (skutočný, nie len optimistický dôkaz
  // uloženia — refetch to potvrdzuje).
  await expect(page.getByTestId("restock-links-empty")).toBeVisible();

  // Zdieľaná zápisová cesta (#239's `product_supplier_link_override`) — tá
  // istá hodnota je vidno aj na "Párovanie produktov", úplne INEJ
  // obrazovke nad tou istou tabuľkou.
  await page.getByRole("button", { name: "Párovanie produktov" }).click();
  await expect(page.getByRole("heading", { name: "Párovanie produktov" })).toBeVisible();
  await page.getByLabel("Zobraziť produkty").selectOption("all");
  await page.getByLabel("Hľadať produkt (kód alebo názov)").fill("E2E-RL-CHYBA");
  await page.getByRole("button", { name: "Zobraziť" }).click();
  await expect(page.getByTestId("product-link-url-E2E-RL-CHYBA")).toHaveAttribute(
    "href",
    "https://e2e-dodavatel.example.com/bunda-alfa-navrh",
  );

  expect(chyby).toEqual([]);
});
