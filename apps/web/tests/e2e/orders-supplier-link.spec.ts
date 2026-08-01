import { expect, test, type ConsoleMessage } from "@playwright/test";

// issue 121: majiteľ, doslovne "ak na produkt nie je odkaz na dodavatela, tak
// tam ma byt moznost ho doplnit, a vlastne pri kazdom produkte ma byt moznost
// upravit link na dodavatela". VLASTNÝ súbor (nie ďalší test v
// `orders.spec.ts`, ktoré je už blízko eslint `max-lines: 400`,
// `.claude/rules/testing.md`).

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze

// Rovnaká a JEDINÁ povolená výnimka ako v ostatných e2e spec súboroch.
const jeOcakavane = (m: ConsoleMessage): boolean =>
  m.location().url.includes("/api/me") && m.text().includes("401");

// VLASTNÝ izolovaný účet — balík je už na hranici `MAX_ATTEMPTS=10`
// (`scripts/e2e-setup.ts`'s komentár k `E2E_ODKAZ_EMAIL`).
const E2E_ODKAZ_EMAIL = "e2e-odkaz@forestshop.sk";

test("riadok bez odkazu ponúka 'doplniť', po uložení ponúka 'upraviť' a nová hodnota prežije obnovenie stránky, konzola je čistá", async ({
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
  await page.getByLabel("E-mail").fill(E2E_ODKAZ_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // Riadok objednávky 9007 (`scripts/e2e-setup.ts`) je nad variantom "278" —
  // jednovariantný produkt BEZ dodávateľa AJ bez odkazu (CSV fixtúra nesie
  // prázdny `internalNote`). Bunka DODÁVATEĽ preto zobrazí "Priradiť
  // dodávateľa" popis (issue 63/107 bod 3) a toggle na odkaz ponúka "Doplniť".
  const skupina = page.getByTestId("supplier-(bez dodávateľa)");
  await expect(skupina).toBeVisible();
  const riadok = skupina.locator("[data-testid^='order-line-']").filter({ hasText: "9007" });
  await expect(riadok).toContainText("ThermVisia");
  // issue 162: vstup+uloženie žijú teraz vo VLASTNOM rozbaľovacom riadku POD
  // `riadok`om (`colSpan` cez celú tabuľku), nie ako jeho potomok — nájde sa
  // cez najbližšieho súrodenca za `riadok`om (toggle tlačidlo OSTÁVA v
  // `riadok`u, nezmenené).
  const editRiadok = riadok.locator("xpath=./following-sibling::tr[1]");
  const toggle = riadok.getByLabel(/Doplniť odkaz na dodávateľa/);
  await expect(toggle).toBeVisible();

  await toggle.click();
  // `{ exact: true }` — inak by táto substring-zhoda kolidovala so susedným
  // tlačidlom "Uložiť odkaz na dodávateľa riadku objednávky ..." (obsahuje
  // ten istý text ako podreťazec, `.claude/rules/testing.md`'s Playwright
  // substring-kolízna poznámka).
  const vstup = editRiadok.getByLabel("Odkaz na dodávateľa riadku objednávky 9007 / 278", { exact: true });
  await expect(vstup).toBeVisible();
  await expect(vstup).toHaveValue("");
  // issue 162: majiteľ, políčko na úpravu odkazu je príliš malé na to, aby
  // bolo vidno, čo sa edituje — naživo namerané 94px. Ticketov akceptačný
  // test žiada aspoň 3× = ≥282px.
  expect((await vstup.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(282);

  await vstup.fill("https://e2e-dodavatel.example.com/produkt-278");
  await editRiadok.getByLabel("Uložiť odkaz na dodávateľa riadku objednávky 9007 / 278").click();

  // Refetch po uložení (`OrdersSection.tsx`'s `setSupplierLink`) — panel sa
  // zavrie, ikonové tlačidlo odkazu sa objaví s NOVOU hodnotou, toggle teraz
  // ponúka "Upraviť" (nie "Doplniť" — hodnota UŽ existuje).
  const odkaz = riadok.getByRole("link", { name: "Odkaz na dodávateľa" });
  await expect(odkaz).toHaveAttribute("href", "https://e2e-dodavatel.example.com/produkt-278");
  await expect(odkaz).toHaveAttribute("target", "_blank");
  await expect(odkaz).toHaveAttribute("rel", "noreferrer noopener");
  await expect(riadok.getByLabel(/Upraviť odkaz na dodávateľa/)).toBeVisible();

  // Pretrvanie po obnovení stránky — odkaz je v DB
  // (`product_supplier_link_override`), nielen v optimistickom klientskom stave.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  const riadokPoReloade = page
    .getByTestId("supplier-(bez dodávateľa)")
    .locator("[data-testid^='order-line-']")
    .filter({ hasText: "9007" });
  const editRiadokPoReloade = riadokPoReloade.locator("xpath=./following-sibling::tr[1]");
  await expect(riadokPoReloade.getByRole("link", { name: "Odkaz na dodávateľa" })).toHaveAttribute(
    "href",
    "https://e2e-dodavatel.example.com/produkt-278",
  );

  // "Upraviť" — nová hodnota PREPÍŠE tú predchádzajúcu (na rozdiel od
  // priradenia dodávateľa, žiadna "už má hodnotu" gate — ticket to žiada
  // explicitne).
  await riadokPoReloade.getByLabel(/Upraviť odkaz na dodávateľa/).click();
  const vstupUprava = editRiadokPoReloade.getByLabel("Odkaz na dodávateľa riadku objednávky 9007 / 278", {
    exact: true,
  });
  await expect(vstupUprava).toHaveValue("https://e2e-dodavatel.example.com/produkt-278");
  await vstupUprava.fill("https://e2e-dodavatel.example.com/opravena-adresa");
  await editRiadokPoReloade.getByLabel("Uložiť odkaz na dodávateľa riadku objednávky 9007 / 278").click();

  await expect(riadokPoReloade.getByRole("link", { name: "Odkaz na dodávateľa" })).toHaveAttribute(
    "href",
    "https://e2e-dodavatel.example.com/opravena-adresa",
  );

  expect(chyby).toEqual([]);
});

// issue 153: neplatný odkaz sa odmietne HNEĎ v prehliadači — konzola musí
// zostať čistá, čo je zároveň dôkaz, že sa NIKDY neodoslal skutočný
// request na server (server 400 by sa v Chromiu zalogoval ako "Failed to
// load resource", `.claude/rules/testing.md`). Riadok 9007/278 už má
// uložený odkaz z PREDCHÁDZAJÚCEHO testu tohto súboru (spoločný účet,
// sekvenčný beh v rámci jedného spec súboru) — toggle preto ponúka
// "Upraviť", nie "Doplniť".
test("neplatný odkaz na dodávateľa sa odmietne HNEĎ, bez zápisu na server (konzola čistá)", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill(E2E_ODKAZ_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  const riadok = page
    .getByTestId("supplier-(bez dodávateľa)")
    .locator("[data-testid^='order-line-']")
    .filter({ hasText: "9007" });
  // issue 162: vstup+uloženie žijú teraz v samostatnom rozbaľovacom riadku.
  const editRiadok = riadok.locator("xpath=./following-sibling::tr[1]");
  await riadok.getByLabel(/Upraviť odkaz na dodávateľa/).click();
  const vstup = editRiadok.getByLabel("Odkaz na dodávateľa riadku objednávky 9007 / 278", { exact: true });
  await expect(vstup).toHaveValue("https://e2e-dodavatel.example.com/opravena-adresa");

  await vstup.fill("nieje-url");
  await editRiadok.getByLabel("Uložiť odkaz na dodávateľa riadku objednávky 9007 / 278").click();

  await expect(page.getByTestId("order-write-failures")).toContainText(
    "Odkaz musí byť platná adresa začínajúca http:// alebo https://.",
  );

  // Pôvodná hodnota ZOSTALA nezmenená — neplatný pokus sa neuložil.
  const odkaz = riadok.getByRole("link", { name: "Odkaz na dodávateľa" });
  await expect(odkaz).toHaveAttribute("href", "https://e2e-dodavatel.example.com/opravena-adresa");

  expect(chyby).toEqual([]);
});
