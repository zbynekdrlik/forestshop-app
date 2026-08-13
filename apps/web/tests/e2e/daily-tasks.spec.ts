import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_ULOHY_EMAIL = "e2e-ulohy@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 342: "Dôležité → Úlohy na dnes" — nahrádza šéfove poznámky písané do
// Discordu. Reálny prehliadač cez celý cyklus: napísať + Enter (žiadny
// formulár), upraviť text, pridať emoji, označiť vybavené (ostáva v
// zozname, len stlmené), odstrániť. Konzola musí zostať čistá
// (`.claude/rules/testing.md`). Účet má rolu "citanie" — server (a teda aj
// appka) nemá pre tento súkromný zoznam žiadne role-podmienené obmedzenie.
test("napísať jedno za druhým, upraviť, pridať emoji, vybaviť (ostáva vidno), odstrániť — konzola je čistá", async ({ page }) => {
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

  // "Písať jedno za druhým" — napísať + Enter, žiadny formulár/dialóg.
  const novyVstup = page.getByTestId("uloha-new-input");
  await novyVstup.fill("Nemáme sáčky");
  await novyVstup.press("Enter");
  await expect(page.getByTestId("ulohy-list").getByText("Nemáme sáčky")).toBeVisible();
  await expect(novyVstup).toHaveValue("");

  await novyVstup.fill("Záhorecký volať");
  await novyVstup.press("Enter");
  await expect(page.getByTestId("ulohy-list").getByText("Záhorecký volať")).toBeVisible();

  // "Najnovšia hore" — druhá pridaná úloha ("Záhorecký volať") je PRVÝ riadok.
  const riadky = page.locator(".uloha-row");
  await expect(riadky).toHaveCount(2);
  await expect(riadky.nth(0)).toContainText("Záhorecký volať");
  await expect(riadky.nth(1)).toContainText("Nemáme sáčky");

  // Nájsť konkrétny riadok podľa aktuálneho textu (rovnaký vzor ako
  // `upozornenia.spec.ts`'s `kartaSNadpisom`, len cez `.uloha-row`).
  const sackyRiadok = page.locator(".uloha-row").filter({ hasText: "Nemáme sáčky" });

  // Upraviť text inline. Kým je riadok v editačnom móde, jeho pôvodný text
  // už NIE JE textovým uzlom v DOM-e (je len hodnotou <input>u), takže
  // `sackyRiadok`'s `hasText` filter by sa prestal zhodovať s KAŽDÝM ĎALŠÍM
  // (lazy) vyhodnotením — vstup/tlačidlo sa preto vyhľadáva GLOBÁLNE cez ich
  // pevný (nie per-riadok interpolovaný) `aria-label`, bezpečné, lebo appka
  // dovolí najviac JEDEN riadok v editácii textu naraz.
  await sackyRiadok.getByRole("button", { name: "Upraviť text" }).click();
  const editInput = page.locator("input.uloha-edit-input");
  await editInput.fill("Nemáme sáčky — objednať zajtra");
  await page.getByRole("button", { name: "Uložiť text" }).click();
  const upravenyRiadok = page.locator(".uloha-row").filter({ hasText: "Nemáme sáčky — objednať zajtra" });
  await expect(upravenyRiadok).toBeVisible();

  // Pridať emoji (samostatná akcia od úpravy textu).
  await upravenyRiadok.getByRole("button", { name: "Pridať/zmeniť emoji" }).click();
  await upravenyRiadok.locator('input[placeholder="😊"]').fill("🛍️");
  await upravenyRiadok.getByRole("button", { name: "Uložiť emoji" }).click();
  await expect(upravenyRiadok.locator(".uloha-emoji")).toHaveText("🛍️");

  // Označiť ako vybavené — úloha OSTÁVA v zozname (nezmizne), len stlmená.
  // issue 403: skutočný `<input type="checkbox">` namiesto `<button>`u —
  // rola je teraz "checkbox", nie "button" (meno ostáva rovnaké).
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
