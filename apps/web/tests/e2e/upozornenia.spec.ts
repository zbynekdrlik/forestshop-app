import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_UPOZORNENIA_EMAIL = "e2e-upozornenia@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 267: "Eshop → Upozornenia" — nástenka + vlastné poznámky. Reálny
// prehliadač cez celý cyklus: vytvoriť, vidieť "Nové" zmiznúť po
// znovunačítaní (mark-seen pri otvorení záložky), upraviť, odložiť, vybaviť,
// zmazať. Konzola musí zostať čistá (`.claude/rules/testing.md`).
//
// Karty majú SERVEROM vygenerované id v testid-e (`upozornenie-<uuid>`), a
// viacero VNORENÝCH prvkov na karte zdieľa rovnaký `upozornenie-` prefix
// (`upozornenie-nove-<id>`, `upozornenie-resolve-<id>`, …) — namiesto
// nejednoznačného testid-prefixového selektora sa preto karty vyhľadávajú
// cez ich CSS TRIEDU `.upozornenie-card` (majú ju LEN karty samotné, žiadny
// vnorený prvok), filtrovanú textom nadpisu.
function kartaSNadpisom(page: import("@playwright/test").Page, nadpis: string) {
  return page.locator(".upozornenie-card").filter({ hasText: nadpis });
}

test("vlastná poznámka — vytvorenie, 'Nové' zmizne po znovuotvorení, úprava, odloženie, vybavenie, zmazanie, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=upozornenia");
  await page.getByLabel("E-mail").fill(E2E_UPOZORNENIA_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Upozornenia" })).toBeVisible();
  // issue 267 follow-up gap 3: skutočne nič nie je zapísané — hláška to
  // musí povedať pravdivo, nie natvrdo "všetko je vybavené".
  await expect(page.getByTestId("upozornenia-empty")).toHaveText("Žiadne upozornenia — nič nie je zapísané.");

  // Vytvorenie vlastnej poznámky.
  await page.getByTestId("upozornenie-new").click();
  await page.getByTestId("upozornenie-form-title").fill("Schôdzka v stredu");
  await page.getByTestId("upozornenie-form-details").fill("O 10:00 s dodávateľom");
  await page.getByTestId("upozornenie-form-save").click();
  await expect(page.getByTestId("upozornenie-form")).toBeHidden();

  const card = kartaSNadpisom(page, "Schôdzka v stredu");
  await expect(card).toBeVisible();
  await expect(card).toContainText("O 10:00 s dodávateľom");
  await expect(card).toContainText("Nové");

  // Znovuotvorenie záložky (reload) je "prečítané" — "Nové" zmizne, karta
  // sa stane "Otvorené" (žiadny text "Nové" na nej).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Upozornenia" })).toBeVisible();
  const cardAfterReload = kartaSNadpisom(page, "Schôdzka v stredu");
  await expect(cardAfterReload).toBeVisible();
  await expect(cardAfterReload).not.toContainText("Nové");

  // Úprava vlastnej poznámky.
  await cardAfterReload.getByRole("button", { name: "Upraviť" }).click();
  await page.getByTestId("upozornenie-form-title").fill("Schôdzka v stredu — presunutá");
  await page.getByTestId("upozornenie-form-save").click();
  const upravenaKarta = kartaSNadpisom(page, "Schôdzka v stredu — presunutá");
  await expect(upravenaKarta).toBeVisible();

  // Odloženie na budúci dátum — karta zmizne z predvoleného zoznamu.
  const budúciDátum = new Date();
  budúciDátum.setDate(budúciDátum.getDate() + 30);
  const isoDen = budúciDátum.toISOString().slice(0, 10);
  await upravenaKarta.locator('input[type="date"]').fill(isoDen);
  await upravenaKarta.getByRole("button", { name: "Odložiť", exact: true }).click();
  await expect(kartaSNadpisom(page, "Schôdzka v stredu — presunutá")).toHaveCount(0);

  // issue 267 follow-up gap 2: "aj odložené" JU odkryje, a "Zrušiť odloženie"
  // ju vráti naspäť skôr, než sa vráti sama.
  await page.getByText("aj odložené").click();
  const odlozenaKarta = kartaSNadpisom(page, "Schôdzka v stredu — presunutá");
  await expect(odlozenaKarta).toBeVisible();
  await expect(odlozenaKarta).toContainText("Odložené");
  await odlozenaKarta.getByRole("button", { name: "Zrušiť odloženie" }).click();
  await page.getByText("aj odložené").click(); // vypnúť filter — karta musí byť viditeľná AJ bez neho
  await expect(kartaSNadpisom(page, "Schôdzka v stredu — presunutá")).toBeVisible();

  // Vlastná druhá poznámka, ktorú rovno vybavíme a zmažeme.
  await page.getByTestId("upozornenie-new").click();
  await page.getByTestId("upozornenie-form-title").fill("Vybaviť poistku");
  await page.getByTestId("upozornenie-form-save").click();
  const poistkaKarta = kartaSNadpisom(page, "Vybaviť poistku");
  await expect(poistkaKarta).toBeVisible();
  await poistkaKarta.getByRole("button", { name: "Vybavené" }).click();
  await expect(kartaSNadpisom(page, "Vybaviť poistku")).toHaveCount(0);

  // issue 283 follow-up: vybavené karty žijú LEN v záložke "Vybavené" —
  // "Otvorené" ich už NIKDY neukáže (checkbox "aj vybavené" bol odstránený
  // spolu s touto duplicitnou zobrazovacou cestou, `.claude/rules/
  // upozornenia.md`), žiadnym prepínačom ju nejde znova odkryť tu.
  await expect(page.getByText("aj vybavené")).toHaveCount(0);
  await expect(kartaSNadpisom(page, "Vybaviť poistku")).toHaveCount(0);

  // issue 283 (majiteľ, komentár na tickete): záložka "Vybavené" — história
  // vybavených kariet + vrátenie omylom vybavenej karty späť medzi otvorené.
  // Kolízia s ČIASTOČNÝM unique indexom (`upozornenie_dedup_key_uq`) NEJDE
  // vyvolať cez ŽIADNU appkinu UI akciu (vlastné poznámky nikdy nenesú
  // `dedupKey` — jedine automatický import ho vyrobí), preto ju overuje
  // `upozornenia-resolved.integration.test.ts`/`upozornenia-resolved-http
  // .integration.test.ts` priamo na DB úrovni (rovnaký princíp ako
  // `e2e-real-user-testing.md`'s výnimka pre scenáre, čo skutočný používateľ
  // klikaním nikdy nevyrobí).
  await page.getByTestId("upozornenia-tab-vybavene").click();
  await expect(page.getByTestId("upozornenia-tab-vybavene")).toHaveAttribute("aria-selected", "true");
  await expect(kartaSNadpisom(page, "Schôdzka v stredu — presunutá")).toHaveCount(0); // len OTVORENÁ karta, tu nepatrí

  const historickaKarta = kartaSNadpisom(page, "Vybaviť poistku");
  await expect(historickaKarta).toBeVisible();
  await expect(historickaKarta).toContainText("Vybavil(a) E2E Manažér");

  // Vrátenie omylom vybavenej karty späť medzi otvorené.
  await historickaKarta.getByRole("button", { name: "Vrátiť medzi otvorené" }).click();
  await expect(kartaSNadpisom(page, "Vybaviť poistku")).toHaveCount(0);

  await page.getByTestId("upozornenia-tab-otvorene").click();
  const vratenaKarta = kartaSNadpisom(page, "Vybaviť poistku");
  await expect(vratenaKarta).toBeVisible();
  await expect(vratenaKarta).not.toContainText("Nové"); // bola už videná pri predchádzajúcom vybavení
  await expect(vratenaKarta.getByRole("button", { name: "Vybavené" })).toBeVisible(); // znova akčná

  expect(chyby).toEqual([]);
});
