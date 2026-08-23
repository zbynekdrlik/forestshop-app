import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_ULOHY_EMAIL = "e2e-ulohy@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 342 + 471: "Dôležité → Úlohy na dnes". Reálny prehliadač cez celý cyklus:
// napísať + Enter (žiadny formulár), vložiť emoji DO textu cez picker (nová úloha
// aj inline edit), označiť CELÚ úlohu emojkou JEDNÝM klikom v pickeri (bez
// textového poľa + Uložiť), zmeniť/odstrániť emoji, upraviť text, vybaviť
// (ostáva v zozname, len stlmené), odstrániť. Konzola musí zostať čistá
// (`.claude/rules/testing.md`). Účet má rolu "citanie" — server (a teda aj
// appka) nemá pre tento súkromný zoznam žiadne role-podmienené obmedzenie.
test("emoji picker do textu úlohy + jednoklikové označenie riadku, upraviť, vybaviť, odstrániť — konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=ulohy");
  await page.getByLabel("E-mail").fill(E2E_ULOHY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Úlohy na dnes" })).toBeVisible();
  await expect(page.getByTestId("ulohy-empty")).toBeVisible();

  // --- Nová úloha S EMOJI V TEXTE cez picker (vloženie na kurzor) ---
  const novyVstup = page.getByTestId("uloha-new-input");
  await novyVstup.fill("Nemáme sáčky ");
  await page.getByTestId("uloha-new-emoji").click();
  await page.locator(".emoji-picker-popover").getByRole("button", { name: "Vložiť 👍" }).click();
  await expect(novyVstup).toHaveValue("Nemáme sáčky 👍");
  await novyVstup.press("Enter");
  await expect(page.getByTestId("ulohy-list").getByText("Nemáme sáčky 👍")).toBeVisible();
  await expect(novyVstup).toHaveValue("");

  await novyVstup.fill("Záhorecký volať");
  await novyVstup.press("Enter");
  await expect(page.getByTestId("ulohy-list").getByText("Záhorecký volať")).toBeVisible();

  // "Najnovšia hore" — druhá pridaná úloha ("Záhorecký volať") je PRVÝ riadok.
  const riadky = page.locator(".uloha-row");
  await expect(riadky).toHaveCount(2);
  await expect(riadky.nth(0)).toContainText("Záhorecký volať");
  await expect(riadky.nth(1)).toContainText("Nemáme sáčky 👍");

  // Nájsť konkrétny riadok podľa aktuálneho textu (rovnaký vzor ako
  // `upozornenia.spec.ts`'s `kartaSNadpisom`, len cez `.uloha-row`).
  const sackyRiadok = page.locator(".uloha-row").filter({ hasText: "Nemáme sáčky" });

  // --- Upraviť text inline + vložiť emoji DO textu cez edit picker ---
  // Kým je riadok v editačnom móde, jeho pôvodný text už NIE JE textovým
  // uzlom v DOM-e (je len hodnotou <input>u), takže `sackyRiadok`'s `hasText`
  // filter by sa prestal zhodovať — vstup/tlačidlá sa preto vyhľadávajú
  // GLOBÁLNE cez ich pevný `aria-label`/testid (appka dovolí najviac JEDEN
  // riadok v editácii textu naraz).
  await sackyRiadok.getByRole("button", { name: "Upraviť text" }).click();
  const editInput = page.locator("input.uloha-edit-input");
  await editInput.fill("Nemáme sáčky — objednať ");
  // Edit picker (label "Vložiť emoji") je vnútri edit riadku — vyhľadá sa
  // scopnuto na riadok obsahujúci edit input, aby nekolidoval s picker-om nad
  // zoznamom (nový-vstup picker má rovnaký label, ale NIE JE v `.uloha-row`).
  const editRiadok = page.locator(".uloha-row").filter({ has: page.locator("input.uloha-edit-input") });
  await editRiadok.getByRole("button", { name: "Vložiť emoji" }).click();
  await page.locator(".emoji-picker-popover").getByRole("button", { name: "Vložiť 🚚" }).click();
  await expect(editInput).toHaveValue("Nemáme sáčky — objednať 🚚");
  await page.getByRole("button", { name: "Uložiť text" }).click();
  const upravenyRiadok = page.locator(".uloha-row").filter({ hasText: "Nemáme sáčky — objednať 🚚" });
  await expect(upravenyRiadok).toBeVisible();

  // --- Označiť CELÝ riadok emojkou JEDNÝM klikom v pickeri (žiadne textové pole) ---
  await upravenyRiadok.getByRole("button", { name: "Pridať/zmeniť emoji" }).click();
  await page.locator(".emoji-picker-popover").getByRole("button", { name: "Vložiť 🚀" }).click();
  // Emoji sa uloží na server (PATCH) a po refetchi sa zobrazí pri riadku.
  await expect(upravenyRiadok.locator(".uloha-emoji")).toHaveText("🚀");

  // --- Zmeniť emoji riadku na iné (opäť jeden klik) ---
  await upravenyRiadok.getByRole("button", { name: "Pridať/zmeniť emoji" }).click();
  await page.locator(".emoji-picker-popover").getByRole("button", { name: "Vložiť 🔥" }).click();
  await expect(upravenyRiadok.locator(".uloha-emoji")).toHaveText("🔥");

  // --- Odstrániť emoji riadku cez voľbu „bez emoji" ---
  await upravenyRiadok.getByRole("button", { name: "Pridať/zmeniť emoji" }).click();
  await page.locator(".emoji-picker-popover").getByRole("button", { name: "Bez emoji" }).click();
  await expect(upravenyRiadok.locator(".uloha-emoji")).toHaveCount(0);

  // Označiť ako vybavené — úloha OSTÁVA v zozname (nezmizne), len stlmená.
  // issue 403: skutočný `<input type="checkbox">` — rola je "checkbox".
  await upravenyRiadok.getByRole("checkbox", { name: "Označiť ako vybavené" }).click();
  await expect(upravenyRiadok).toHaveClass(/done/);
  await expect(riadky).toHaveCount(2); // stále obe, žiadna nezmizla

  // Odstránenie druhej úlohy — okamžite, bez potvrdzovacieho dialógu.
  const zaharecKyRiadok = page.locator(".uloha-row").filter({ hasText: "Záhorecký volať" });
  await zaharecKyRiadok.getByRole("button", { name: "Odstrániť" }).click();
  await expect(page.locator(".uloha-row")).toHaveCount(1);
  await expect(page.getByText("Záhorecký volať")).toHaveCount(0);

  // Upratanie po teste — druhý (vybavený) riadok tiež zmazať.
  await upravenyRiadok.getByRole("button", { name: "Odstrániť" }).click();
  await expect(page.getByTestId("ulohy-empty")).toBeVisible();

  expect(chyby).toEqual([]);
});
