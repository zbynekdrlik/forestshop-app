import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_POZNAMKY_EMAIL = "e2e-poznamky@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 437: "Poznámky" — ZDIEĽANÁ nástenka rýchlych poznámok (mobilný zápis +
// PWA). Reálny prehliadač v MOBILNOM viewporte (375px, ako `mobile-
// responsive.spec.ts`) cez celý cyklus: prihlásiť → napísať do veľkého
// textového poľa + Uložiť → vidieť v zozname (autor + telo) → vybaviť
// (ostáva vidno, len stlmené) → zmazať. Konzola musí zostať čistá
// (`.claude/rules/testing.md`). Účet má rolu "sef" (Štěpán) — server nemá
// pre zdieľanú nástenku žiadne role-podmienené obmedzenie, test to overuje.
test("mobil (375px): napísať poznámku, vidieť ju v zozname, vybaviť — zdieľaná nástenka, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.setViewportSize({ width: 375, height: 800 });
  // PWA `start_url` mieri na `/?tab=poznamky` — appka sa z plochy telefónu
  // otvorí rovno sem; test ide na tú istú adresu.
  await page.goto("/?tab=poznamky");
  await page.getByLabel("E-mail").fill(E2E_POZNAMKY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Poznámky" })).toBeVisible();
  await expect(page.getByTestId("poznamky-empty")).toBeVisible();

  // Napísať do VEĽKÉHO textového poľa + Uložiť (žiadny riadkový vstup).
  const vstup = page.getByTestId("poznamka-new-input");
  await vstup.fill("Nemáme sáčky, objednať u dodávateľa");
  await page.getByTestId("poznamka-new-save").click();
  await expect(page.getByTestId("poznamky-list").getByText("Nemáme sáčky, objednať u dodávateľa")).toBeVisible();
  // Pole sa po uložení vyprázdni.
  await expect(vstup).toHaveValue("");

  // Autor je zobrazený (zdieľaná nástenka) — seedovaný účet má displayName "E2E Šéf".
  const prvaPoznamka = page.locator(".poznamka-row").filter({ hasText: "Nemáme sáčky, objednať u dodávateľa" });
  await expect(prvaPoznamka).toContainText("E2E Šéf");

  // Druhá poznámka — najnovšia hore.
  await vstup.fill("Zavolať Záhoreckému ohľadom termínu");
  await page.getByTestId("poznamka-new-save").click();
  await expect(page.getByTestId("poznamky-list").getByText("Zavolať Záhoreckému ohľadom termínu")).toBeVisible();
  const riadky = page.locator(".poznamka-row");
  await expect(riadky).toHaveCount(2);
  await expect(riadky.nth(0)).toContainText("Zavolať Záhoreckému ohľadom termínu");
  await expect(riadky.nth(1)).toContainText("Nemáme sáčky, objednať u dodávateľa");

  // Vybaviť prvú poznámku — OSTÁVA v zozname (nezmizne), len stlmená.
  // `.click()` + `toHaveClass`/`toBeChecked` čaká na potvrdený zápis
  // (`.claude/rules/testing.md`'s checkbox vzor), nie `.check()`.
  await prvaPoznamka.getByRole("checkbox", { name: "Označiť ako vybavené" }).click();
  await expect(prvaPoznamka).toHaveClass(/done/);
  await expect(riadky).toHaveCount(2); // stále obe, žiadna nezmizla

  // Upratanie po teste — obe poznámky zmazať, späť do prázdneho stavu.
  const druhaPoznamka = page.locator(".poznamka-row").filter({ hasText: "Zavolať Záhoreckému ohľadom termínu" });
  await druhaPoznamka.getByRole("button", { name: "Odstrániť poznámku" }).click();
  await expect(page.locator(".poznamka-row")).toHaveCount(1);
  await prvaPoznamka.getByRole("button", { name: "Odstrániť poznámku" }).click();
  await expect(page.getByTestId("poznamky-empty")).toBeVisible();

  expect(chyby).toEqual([]);
});

// issue 440: emoji picker — vloženie emoji do textu poznámky cez tlačidlo (na
// pozíciu kurzora), uloženie, zobrazenie v zozname. Desktop AJ mobilný viewport
// (zadanie: "desktop aj mobilný viewport pri Poznámkach"). Emoji sa ukladá a
// zobrazuje správne (perzistenciu zamyká `emoji-persist.integration.test.ts`).
test("emoji picker (desktop + mobil): vloží emoji cez tlačidlo, uloží, vidno v zozname, konzola čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.setViewportSize({ width: 1280, height: 900 }); // desktop
  await page.goto("/?tab=poznamky");
  await page.getByLabel("E-mail").fill(E2E_POZNAMKY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Poznámky" })).toBeVisible();

  const vstup = page.getByTestId("poznamka-new-input");

  // Desktop: napísať text, vložiť emoji cez picker na koniec (kurzor), uložiť.
  await vstup.fill("Objednať sáčky ");
  await page.getByTestId("poznamka-emoji").click();
  await page.getByRole("menuitem", { name: "Vložiť 👍" }).click();
  await expect(vstup).toHaveValue("Objednať sáčky 👍");
  await page.getByTestId("poznamka-new-save").click();
  await expect(page.getByTestId("poznamky-list").getByText("Objednať sáčky 👍")).toBeVisible();

  // Mobil (375px): to isté, iné emoji.
  await page.setViewportSize({ width: 375, height: 800 });
  await vstup.fill("Zavolať ");
  await page.getByTestId("poznamka-emoji").click();
  await page.getByRole("menuitem", { name: "Vložiť 🎉" }).click();
  await expect(vstup).toHaveValue("Zavolať 🎉");
  await page.getByTestId("poznamka-new-save").click();
  await expect(page.getByTestId("poznamky-list").getByText("Zavolať 🎉")).toBeVisible();

  // Upratanie po teste.
  const p1 = page.locator(".poznamka-row").filter({ hasText: "Objednať sáčky 👍" });
  const p2 = page.locator(".poznamka-row").filter({ hasText: "Zavolať 🎉" });
  await p2.getByRole("button", { name: "Odstrániť poznámku" }).click();
  await expect(p2).toHaveCount(0);
  await p1.getByRole("button", { name: "Odstrániť poznámku" }).click();
  await expect(p1).toHaveCount(0);

  expect(chyby).toEqual([]);
});
