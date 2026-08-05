import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_NEDOSTUPNE_EMAIL = "e2e-nedostupne@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 176: "Nedostupné tovary" je SKRYTÁ obrazovka (rovnaký vzor ako
// #172/#173 — majiteľ chce v ľavom menu zatiaľ len "Sync zo Shoptetu"/"Na
// objednanie", issue 57) — dostupná cez `?tab=nedostupne`.
//
// Toto NEKONTAKTUJE skutočný SMTP: `playwright.config.ts`'s API `webServer`
// nenastavuje `MAIL_HOST`, takže `mailTransport` je v tomto behu `undefined`
// (rovnaká úvaha ako `order-reminder.spec.ts`/`posta-uncollected.spec.ts`).
// Fixtúrová objednávka "9008" (`scripts/e2e-setup.ts`) má riadok variantu
// "40287" v stave 'nedostupne', s pripraveným prekliku na náš e-shop
// (`shop_product_url`) a na dodávateľa (`product_supplier_link_override`).
//
// issue 238: automatický "Náhrada: 60297" návrh (`product.relatedCodes`) je
// preč — tento test overuje RUČNÉ pridanie/zmazanie odkazu náhrady namiesto
// neho, prekliky na e-shop/dodávateľa, a že OBIDVE preview tlačidlá stále
// ukazujú upraviteľné znenie e-mailu (existujúci `mail-templates` mechanizmus,
// issue 192 — táto zmena mení len ZDROJ zoznamu náhrad, nie mechanizmus).
test("ručné odkazy náhrad, prekliky na e-shop/dodávateľa, povinný náhľad predchádza odoslaniu, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=nedostupne");
  await page.getByLabel("E-mail").fill(E2E_NEDOSTUPNE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Nedostupné tovary" })).toBeVisible();

  // Chýbajúca BCC/mail konfigurácia (E2E beh) sa zobrazí ako varovania.
  await expect(page.getByTestId("nedostupne-bcc-missing")).toBeVisible();
  await expect(page.getByTestId("nedostupne-mail-not-configured")).toBeVisible();

  const group = page.getByTestId("nedostupne-group-40287");
  await expect(group).toBeVisible();
  await expect(group.getByText("E2E Zákazník Nedostupné")).toBeVisible();

  // issue 238: automatický návrh je PREČ — katalógová fixtúra stále nesie
  // `relatedProduct = "60297"` pre tento variant, appka ho už nesmie
  // zobraziť nikde na karte.
  await expect(group.getByText("60297")).toHaveCount(0);

  // Preklik na náš e-shop (názov produktu) a na dodávateľa (kód variantu) —
  // obe pripravené vo fixtúre (`scripts/e2e-setup.ts`).
  const shopLink = page.getByTestId("nedostupne-shop-link-40287");
  await expect(shopLink).toBeVisible();
  await expect(shopLink).toHaveAttribute("href", "https://www.forestshop.sk/e2e-nedostupne-40287/");
  const supplierLink = page.getByTestId("nedostupne-supplier-link-40287");
  await expect(supplierLink).toBeVisible();
  await expect(supplierLink).toHaveAttribute("href", "https://dodavatel.example/e2e-nedostupne-40287");

  // Ručné pridanie odkazu náhrady — pole musí prijať VIAC liniek na ten istý
  // tovar (ticketova akceptačná podmienka).
  const linkInput = group.getByTestId("nedostupne-replacement-link-input-40287");
  await linkInput.fill("https://www.forestshop.sk/e2e-nahrada-1/");
  await group.getByTestId("nedostupne-replacement-link-add-40287").click();
  await expect(group.getByText("https://www.forestshop.sk/e2e-nahrada-1/")).toBeVisible();
  await expect(linkInput).toHaveValue("");

  await linkInput.fill("https://www.forestshop.sk/e2e-nahrada-2/");
  await group.getByTestId("nedostupne-replacement-link-add-40287").click();
  await expect(group.getByText("https://www.forestshop.sk/e2e-nahrada-2/")).toBeVisible();

  // Odkazy prežijú znovunačítanie stránky (uložené v DB, nie len lokálny stav).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Nedostupné tovary" })).toBeVisible();
  const groupAfterReload = page.getByTestId("nedostupne-group-40287");
  await expect(groupAfterReload.getByText("https://www.forestshop.sk/e2e-nahrada-1/")).toBeVisible();
  await expect(groupAfterReload.getByText("https://www.forestshop.sk/e2e-nahrada-2/")).toBeVisible();

  // Náhľad "S náhradou" ukáže PRESNE tieto ručné odkazy (nikdy automatický
  // návrh) — a stále cez existujúci upraviteľný `mail-templates` mechanizmus
  // (issue 192), táto zmena mení len zdroj `zoznam_nahrad`.
  await groupAfterReload.getByTestId("nedostupne-alt-send-9008-40287").click();
  const preview = page.getByTestId("nedostupne-preview");
  const previewBody = page.getByTestId("nedostupne-preview-body");
  await expect(preview).toBeVisible();
  // issue 277: text e-mailu je odteraz EDITOVATEĽNÝ (textarea, nie read-only
  // náhľad) — predvyplnený plain-textovou verziou appky.
  await expect(previewBody).toHaveValue(/https:\/\/www\.forestshop\.sk\/e2e-nahrada-1\//);
  await expect(previewBody).toHaveValue(/https:\/\/www\.forestshop\.sk\/e2e-nahrada-2\//);
  await page.getByTestId("nedostupne-preview-cancel").click();
  await expect(preview).toBeHidden();

  // Zmazanie jedného odkazu — ostatné zostávajú.
  const links = groupAfterReload.locator(".nedostupne-replacement-links li");
  await expect(links).toHaveCount(2);
  await groupAfterReload
    .locator(".nedostupne-replacement-links li", { hasText: "e2e-nahrada-1" })
    .getByRole("button", { name: /zmazať/ })
    .click();
  await expect(groupAfterReload.getByText("https://www.forestshop.sk/e2e-nahrada-1/")).toHaveCount(0);
  await expect(groupAfterReload.getByText("https://www.forestshop.sk/e2e-nahrada-2/")).toBeVisible();

  // Klik na "náhľad" (bez náhrady) otvorí povinný náhľad e-mailu PRED
  // akýmkoľvek odoslaním.
  await groupAfterReload.getByTestId("nedostupne-send-9008-40287").click();
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("e2e-nedostupne@forestshop.sk");

  // issue 191: náhľad je dialóg cez obrazovku, nie blok na spodku stránky —
  // musí byť v zornom poli bez skrolovania (jeho vrch je nad spodkom okna) a
  // musí sa dať zavrieť klávesom Esc bez toho, aby čokoľvek odišlo.
  const vyska = page.viewportSize()?.height ?? 0;
  const ramec = await preview.boundingBox();
  expect(ramec).not.toBeNull();
  expect(ramec?.y ?? Number.MAX_SAFE_INTEGER).toBeLessThan(vyska);

  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();

  // Po zavretí sa fokus vracia na tlačidlo, ktoré náhľad otvorilo — obsluha
  // ovládajúca appku klávesnicou ostáva na svojom mieste v zozname. Tlačidlo je
  // počas načítania náhľadu `disabled`, takže prehliadač z neho fokus zhodí:
  // dialóg si spúšťač musí pamätať už z kliknutia, nie až z chvíle otvorenia
  // (nájdené pri živom overení na produkcii, issue 191). jsdom tento stav
  // nevie napodobniť, preto sa to overuje len tu, v skutočnom prehliadači.
  await expect(page.getByTestId("nedostupne-send-9008-40287")).toBeFocused();

  // Znovu otvoriť a pokračovať v pôvodnom overení odoslania.
  await page.getByTestId("nedostupne-send-9008-40287").click();
  await expect(preview).toBeVisible();

  // issue 277: obsluha text v okne priamo prepíše — appka to prijme (žiadna
  // validácia formátu, len nesmie zostať prázdne) a pokúsi sa poslať
  // upravenú verziu (fail-closed BCC kontrola nižšie to aj tak zastaví, no
  // úprava samotná appku nezablokuje).
  await previewBody.fill("Dobrý deň, e2e zákazník — dopĺňam vlastnú vetu priamo v náhľade.");
  await expect(previewBody).toHaveValue("Dobrý deň, e2e zákazník — dopĺňam vlastnú vetu priamo v náhľade.");

  // Potvrdenie odoslania bez nakonfigurovaného mailu vráti graceful chybu
  // (fail-closed, žiadny skutočný pokus o SMTP spojenie) — BCC kontrola beží
  // PRED mail-transport kontrolou (`send.ts`), takže táto hláška sa zobrazí.
  await page.getByTestId("nedostupne-preview-confirm").click();
  await expect(page.getByText("chýba adresa pre skrytú kópiu majiteľovi (NEDOSTUPNE_BCC_EMAIL)", { exact: true })).toBeVisible();

  // Neúspešné odoslanie náhľad ZÁMERNE nezatvára (obsluha vidí dôvod) —
  // zavrie ho až tlačidlo "Zrušiť".
  await expect(preview).toBeVisible();
  await page.getByTestId("nedostupne-preview-cancel").click();
  await expect(preview).toBeHidden();

  expect(chyby).toEqual([]);
});
