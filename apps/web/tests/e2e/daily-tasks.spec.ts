import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_ULOHY_EMAIL = "e2e-ulohy@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 342 + 471: "Dôležité → Úlohy na dnes". Reálny prehliadač cez celý cyklus:
// napísať + Enter (žiadny formulár), vložiť emoji DO textu cez picker (nová úloha
// aj inline edit), označiť CELÚ úlohu emojkou JEDNÝM klikom v pickeri (bez
// textového poľa + Uložiť), zmeniť/odstrániť emoji, upraviť text, vybaviť
// (ostáva v zozname, len stlmené), odstrániť. Konzola musí zostať čistá
// (`.claude/rules/testing.md`). Účet má rolu "citanie" — server (a teda aj
// appka) nemá pre tento ZDIEĽANÝ zoznam (#487) žiadne role-podmienené
// obmedzenie; autor sa zobrazuje pri riadku.
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

  // issue 487: zdieľaný zoznam — pri každom riadku je jeho autor (seedovaný
  // účet `e2e-ulohy@forestshop.sk` má displayName "E2E Čitateľ").
  await expect(riadky.nth(0).locator(".uloha-author")).toHaveText("E2E Čitateľ");
  await expect(riadky.nth(1).locator(".uloha-author")).toHaveText("E2E Čitateľ");

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

// issue 519: "Hlasová poznámka do úloh" — reálny prehliadač cez celý cyklus
// nahrávania. E2E prostredie NEMÁ `OPENAI_API_KEY`, takže sa testuje AUDIO-ONLY
// fallback (prepis sa nespustí, uloží sa zástupný text „🎤 Hlasová poznámka") —
// vrátane prehrania a zmazania nahrávky. Fake mikrofón je zapnutý v
// `playwright.config.ts` (`--use-fake-device-for-media-stream`). Reálny Whisper
// prepis + reálny mikrofón overí supervisor pri živom nasadení. Konzola musí
// zostať čistá (`.claude/rules/testing.md`). Test je SELF-CONTAINED — nesaháva
// na globálnu prázdnotu ani počty (`daily_task` je zdieľaná tabuľka, issue 480),
// pracuje výhradne s VLASTNÝM riadkom a po sebe upratuje.
test("nahranie hlasovej poznámky (audio-only fallback): nahrať → uložiť → prehrať → zmazať nahrávku — konzola je čistá", async ({ page }) => {
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

  // --- Nahrávanie (vzor Messenger) ---
  await page.getByTestId("uloha-new-mic").click();
  await expect(page.getByTestId("uloha-rec-bar")).toBeVisible();
  await expect(page.getByTestId("uloha-rec-stop")).toBeVisible();
  // Nahraj ~1,5 s reálneho (fake) zvuku, aby nahrávka bezpečne prekročila
  // spodný strop veľkosti (1 KB) a server ju prijal (nie 400).
  await page.waitForTimeout(1500);
  await page.getByTestId("uloha-rec-stop").click();

  // Prepis sa v e2e nespustí (bez kľúča) → uloží sa zástupný text audio-only.
  // Objavenie riadku JE dôkaz, že nahrávka + upload + uloženie prebehli.
  const mojRiadok = page.locator(".uloha-row").filter({ hasText: "Hlasová poznámka" });
  await expect(mojRiadok).toBeVisible({ timeout: 15_000 });

  const prehrat = mojRiadok.getByRole("button", { name: "Prehrať hlasovú poznámku" });
  const zmazatNahravku = mojRiadok.getByRole("button", { name: "Zmazať hlasovú nahrávku" });
  await expect(prehrat).toBeVisible();
  await expect(zmazatNahravku).toBeVisible();

  // --- Prehrať nahrávku (klik = user gesture) — nesmie zlyhať prehrávanie ---
  await prehrat.click();
  await page.waitForTimeout(600);
  await expect(mojRiadok.locator(".uloha-audio-failed")).toHaveCount(0);

  // --- Zmazať LEN nahrávku — úloha (zástupný text) OSTÁVA ---
  await zmazatNahravku.click();
  await expect(mojRiadok.getByRole("button", { name: "Prehrať hlasovú poznámku" })).toHaveCount(0);
  await expect(mojRiadok).toBeVisible(); // úloha ostala

  // Upratanie po teste — zmazať celú úlohu.
  await mojRiadok.getByRole("button", { name: /^Odstrániť úlohu/ }).click();
  await expect(page.locator(".uloha-row").filter({ hasText: "Hlasová poznámka" })).toHaveCount(0);

  expect(chyby).toEqual([]);
});

// issue 538: na mobilnom viewporte (~360-430px) sa text prepisu hlasovej
// poznámky (aj bežný dlhší text) vykresľoval PO JEDNOM ZNAKU pod seba —
// `.uloha-row`ov jediný flexibilný prvok `.uloha-text` (flex:1 1 auto;
// min-width:0) dostal celý deficit, keď pevní súrodenci (autor + audio
// ovládanie + akcie) na úzkom `.ulohy-panel`i (rail-mód sidebaru pod
// ~640px) takmer/úplne zaplnili šírku riadku — nameraná šírka 0px
// (`.claude/rules/daily-tasks.md`). Test meria SKUTOČNE vykreslenú šírku
// textového elementu v reálnom 390px viewporte — musí prejsť len keď je
// text zalomený NORMÁLNE (po slovách), nie keď skolaboval na ~1 znak.
test("mobil (390px): prepis dlhšieho textu úlohy sa zalamuje po slovách, nie po znakoch", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

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

  const dlhyText = "Skúška mikrofónu, skúšame či to funguje a či sa text pekne zalomí na viac riadkov.";
  const novyVstup = page.getByTestId("uloha-new-input");
  await novyVstup.fill(dlhyText);
  await novyVstup.press("Enter");

  const riadok = page.locator(".uloha-row").filter({ hasText: "Skúška mikrofónu" });
  await expect(riadok).toBeVisible();

  const textWidth = await riadok.locator(".uloha-text").evaluate((el) => el.getBoundingClientRect().width);
  // Jeden vykreslený znak pri tomto písme je cca 6-10px širokom (kolabovaný
  // stĺpec); normálne zalomená šírka na 390px okne je ~200-260px. 100px je
  // bezpečne nad kolapsom a bezpečne pod normálnou šírkou.
  expect(textWidth).toBeGreaterThan(100);

  // Riadok ostáva funkčný — ovládacie tlačidlo je stále viditeľné a klikateľné.
  await expect(riadok.getByRole("button", { name: "Upraviť text" })).toBeVisible();

  // Upratanie po teste.
  await riadok.getByRole("button", { name: /^Odstrániť úlohu/ }).click();
  await expect(page.locator(".uloha-row").filter({ hasText: "Skúška mikrofónu" })).toHaveCount(0);

  expect(chyby).toEqual([]);
});

// Follow-up k issue 538: issue 538's fix (`.uloha-row { flex-wrap: wrap }`)
// rieši pretečenie RIADKOV zoznamu, ale NIE pridávacieho riadku
// (`.ulohy-add-row` — vstup + mikrofón + "+ Pridať"), ktorý zostáva
// `display:flex` bez `flex-wrap`. Na 390px viewporte s MANUÁLNE
// ROZBALENÝM sidebarom (250px, na rozdiel od predvoleného rail-módu
// 72px pod ~640px) je dostupná šírka `<main>` príliš úzka, aby sa vstup +
// mikrofón + tlačidlo zmestili na jeden riadok bez zalomenia — appka
// pretečie vodorovne (`.claude/rules/daily-tasks.md`). Test meria
// `document.documentElement.scrollWidth` proti `window.innerWidth` presne
// v tomto scenári (rozbalený sidebar), rail-mód aj desktop ostávajú
// nedotknuté (mimo tejto media query).
test("mobil (390px) s rozbaleným sidebarom: pridávací riadok Úloh na dnes nepreteká vodorovne", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

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

  // Sidebar štartuje na 390px v rail-móde (predvolené pod ~640px) — ručne
  // ho rozbaliť, presne scenár z issue 538's živého overenia.
  const railToggle = page.getByTestId("sidebar-rail-toggle");
  await railToggle.click();
  await expect(page.locator(".sidebar.sidebar-rail")).toHaveCount(0);

  const addRow = page.getByTestId("uloha-add-row");
  await expect(addRow).toBeVisible();

  const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

  expect(chyby).toEqual([]);
});
