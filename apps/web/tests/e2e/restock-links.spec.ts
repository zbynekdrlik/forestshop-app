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
// issue 331: klik na návrh odteraz UKLADÁ PRIAMO (jeden klik, nie
// predvyplň-a-potom-Uložiť) — a odznak v ľavom menu (rovnaký generický
// mechanizmus ako issue 147/267) je vidno HNEĎ po prihlásení, bez toho, aby
// sa na túto záložku vôbec kliklo.

test("odznak v menu ukazuje počet chýbajúcich odkazov HNEĎ po prihlásení, bez otvorenia záložky; konzola je čistá", async ({
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

  // Predvolená landing obrazovka je "Na objednanie" (issue 302) — odznak
  // musí byť vidno TU, bez toho, aby sa na "Vypredané → Skladom: návrhy
  // odkazov" vôbec kliklo. Presné číslo je zdieľaný fixtúrový stav (iné
  // spec súbory môžu bežať súbežne) — over PLATNÝ tvar, nie presnú
  // hodnotu, rovnaký princíp ako `nav.spec.ts`'s `nav-badge-orders`.
  const odznak = page.getByTestId("nav-badge-restock-links");
  await expect(odznak).toBeVisible();
  await expect(odznak).toHaveText(/^\d+$/);

  expect(chyby).toEqual([]);
});

test("vypredaný produkt bez linky ponúkne návrh podľa zhody mena + dodávateľa, jeden klik ho rovno potvrdí a zdieľa sa s Párovaním produktov; konzola je čistá", async ({
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
  // VIDITEĽNÝ, meno aj adresa sú na tlačidle vidno PRED kliknutím — ale
  // NIČ sa nikdy neuloží samo, len explicitný klik na "✅ Potvrdiť" uloží
  // TOHTO KONKRÉTNEHO kandidáta.
  const potvrdTlacidlo = riadok.getByTestId("restock-link-confirm-E2E-RL-CHYBA-E2E-RL-NAVRH");
  await expect(potvrdTlacidlo).toContainText("https://e2e-dodavatel.example.com/bunda-alfa-navrh");
  // Nesúvisiaci produkt sa v návrhu NIKDY neobjaví.
  await expect(riadok).not.toContainText("E2E Šál Zeta Cudzí");

  await potvrdTlacidlo.click();

  // Produkt teraz MÁ linku — táto obrazovka zobrazuje LEN produkty BEZ nej,
  // takže po uložení riadok zmizne (skutočný, nie len optimistický dôkaz
  // uloženia — refetch to potvrdzuje).
  await expect(page.getByTestId("restock-links-empty")).toBeVisible();

  // Odznak v menu sa po potvrdení sám prepočíta — číslo je ZDIEĽANÝ globálny
  // stav (počíta VŠETKY vypredané produkty v celej e2e DB, nielen tie z
  // tohto účtu), iné súbežne bežiace spec súbory ho môžu meniť naraz, preto
  // sa overuje len PLATNÝ TVAR (rovnaký princíp ako `nav.spec.ts`'s
  // `nav-badge-orders`), nikdy presná hodnota.
  await expect(page.getByTestId("nav-badge-restock-links")).toHaveText(/^\d+$/);

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
