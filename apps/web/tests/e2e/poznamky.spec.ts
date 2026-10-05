import { expect, test } from "@playwright/test";
import { expectCappedAndScrollable, expectEmptyAboutThreeLines, expectGrowsWhileTyping, expectNothingHidden, fieldMetrics, lines } from "./writingField.js";

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

// issue 591: Štěpán „poznamka sa neda editovať oprav to aby som vedel opraviť čo
// som napísal". Reálny prehliadač: napísať poznámku s preklepom → klik na text
// prepne riadok do úpravy → nový text + REÁLNY Enter (`press`, nie `.fill()` —
// `.fill()` keydown nespustí, `.claude/rules/testing.md` issue 150) → po
// obnovení stránky ostáva opravený text. Potom ✏️ + Esc: rozpísaná zmena sa
// zahodí. Riadok sa hľadá cez VLASTNÉ id (testid), nie `hasText` — počas úpravy
// je text v `<textarea>` a `hasText` by riadok nenašiel (issue 342 pasca); test
// po sebe svoju poznámku zmaže, ostatné testy súboru tak začínajú od prázdna.
test("upraviť text uloženej poznámky — klik na text, Enter uloží, po obnovení ostáva; ✏️ + Esc zruší; konzola čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=poznamky");
  await page.getByLabel("E-mail").fill(E2E_POZNAMKY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Poznámky" })).toBeVisible();

  await page.getByTestId("poznamka-new-input").fill("Zavolat dodavatelovy kvoli sackom");
  await page.getByTestId("poznamka-new-save").click();
  const riadok = page.locator(".poznamka-row").filter({ hasText: "Zavolat dodavatelovy kvoli sackom" });
  await expect(riadok).toBeVisible();
  const testId = await riadok.getAttribute("data-testid");
  const id = (testId ?? "").replace("poznamka-row-", "");
  expect(id).not.toBe("");

  // Klik na text → úprava v riadku, predvyplnená pôvodným textom.
  await page.getByTestId(`poznamka-body-${id}`).click();
  const editor = page.getByTestId(`poznamka-edit-input-${id}`);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("Zavolat dodavatelovy kvoli sackom");
  await editor.fill("Zavolať dodávateľovi kvôli sáčkom");
  await editor.press("Enter");
  // Úprava sa zavrie AŽ po potvrdenom zápise — čaká na dokončenie PATCH pred reloadom.
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId(`poznamka-body-${id}`)).toHaveText("Zavolať dodávateľovi kvôli sáčkom");

  // Po obnovení stránky je uložený opravený text (zo servera, nie z pamäte).
  await page.reload();
  await expect(page.getByTestId(`poznamka-body-${id}`)).toHaveText("Zavolať dodávateľovi kvôli sáčkom");

  // ✏️ otvorí úpravu, Esc ju zruší — rozpísaná zmena sa neuloží.
  await page.getByTestId(`poznamka-edit-${id}`).click();
  await expect(editor).toBeFocused();
  await editor.fill("toto sa neuloží");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId(`poznamka-body-${id}`)).toHaveText("Zavolať dodávateľovi kvôli sáčkom");
  await page.reload();
  await expect(page.getByTestId(`poznamka-body-${id}`)).toHaveText("Zavolať dodávateľovi kvôli sáčkom");

  // Úzky riadok (375px pri rozbalenom bočnom paneli z desktopu): ✏️ ako tretí pevný
  // prvok vedľa checkboxu a 🗑 nesmie stlačiť text poznámky na 0px (CI PR 592).
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByTestId(`poznamka-body-${id}`)).toBeVisible();
  expect((await page.getByTestId(`poznamka-body-${id}`).boundingBox())?.width ?? 0).toBeGreaterThan(40);

  // Upratanie po teste.
  await page.getByTestId(`poznamka-delete-${id}`).click();
  await expect(page.getByTestId(`poznamka-row-${id}`)).toHaveCount(0);

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
  await page.getByRole("button", { name: "Vložiť 👍" }).click();
  await expect(vstup).toHaveValue("Objednať sáčky 👍");
  await page.getByTestId("poznamka-new-save").click();
  await expect(page.getByTestId("poznamky-list").getByText("Objednať sáčky 👍")).toBeVisible();

  // Mobil (375px): to isté, iné emoji.
  await page.setViewportSize({ width: 375, height: 800 });
  await vstup.fill("Zavolať ");
  await page.getByTestId("poznamka-emoji").click();
  await page.getByRole("button", { name: "Vložiť 🎉" }).click();
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

// issue 593 (Štěpán + ROZHODNUTÉ majiteľa 5. 10. 2026 — auto-grow): pole novej
// poznámky AJ pole úpravy — prázdne ~3 riadky, pri písaní s Enter (v úprave
// Shift+Enter, Enter ukladá) narastie na obsah bez skrytého textu, 60 riadkov
// = strop 50vh + posúvanie s dosiahnuteľným posledným riadkom, po uložení späť
// na 3 riadky, otvorenie úpravy DLHEJ poznámky má hneď výšku podľa textu.
// Desktop AJ 375px (prepnutie 1280→375 nechá bočný panel rozbalený = najužší
// riadok, `notes.md` 375px pasca). Jedno prihlásenie (rate-limit účtu).
test("pole na písanie rastie s textom: prázdne 3 riadky, Enter rastie, strop 50vh s posúvaním, po uložení späť, dlhá úprava hneď celá — desktop aj 375px; konzola čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?tab=poznamky");
  await page.getByLabel("E-mail").fill(E2E_POZNAMKY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Poznámky" })).toBeVisible();
  const nova = page.getByTestId("poznamka-new-input");

  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const prazdna = await expectEmptyAboutThreeLines(nova);
    const narastla = await expectGrowsWhileTyping(nova, "Enter");
    const strop = await expectCappedAndScrollable(nova);
    console.log(`issue 593 poznamka-new-input @${String(width)}px: prázdne ${JSON.stringify(prazdna)} 6 riadkov ${JSON.stringify(narastla)} 60 riadkov ${JSON.stringify(strop)}`);

    // Uloženie 8-riadkovej poznámky → pole sa vráti na ~3 riadky.
    const text = lines(8, `pozn593w${String(width)}`);
    await nova.fill(text);
    await page.getByTestId("poznamka-new-save").click();
    const riadok = page.locator(".poznamka-row").filter({ hasText: `pozn593w${String(width)} 8` });
    await expect(riadok).toBeVisible();
    await expectEmptyAboutThreeLines(nova);
    const id = ((await riadok.getAttribute("data-testid")) ?? "").replace("poznamka-row-", "");
    expect(id).not.toBe("");

    // Otvorenie úpravy DLHEJ poznámky → výška hneď podľa textu, nič skryté.
    await page.getByTestId(`poznamka-edit-${id}`).click();
    const editor = page.getByTestId(`poznamka-edit-input-${id}`);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(text);
    const dlha = await expectNothingHidden(editor);
    expect(dlha.contentHeight + 2).toBeGreaterThanOrEqual(8 * dlha.lineHeight);
    console.log(`issue 593 poznamka-edit-input @${String(width)}px otvorená 8 riadkov: ${JSON.stringify(dlha)}`);

    await editor.fill("");
    await expectEmptyAboutThreeLines(editor);
    await expectGrowsWhileTyping(editor, "Shift+Enter");
    await expectCappedAndScrollable(editor);
    // Esc zruší úpravu — nič sa neuloží.
    await editor.press("Escape");
    await expect(editor).toHaveCount(0);
    expect((await fieldMetrics(nova)).overflowY).toBe("auto");

    await page.getByTestId(`poznamka-delete-${id}`).click();
    await expect(page.getByTestId(`poznamka-row-${id}`)).toHaveCount(0);
  }

  expect(chyby).toEqual([]);
});
