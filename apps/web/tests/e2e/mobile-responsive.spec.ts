import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// issue 291: VLASTNÝ, IZOLOVANÝ účet len pre tento súbor — rovnaký dôvod aj
// mechanizmus ako ostatné `E2E_*_EMAIL` konštanty v `scripts/e2e-setup.ts`
// (zdieľaný `e2e@forestshop.sk` je už na hranici `MAX_ATTEMPTS`, `.claude/
// rules/frontend-design.md`). Musí sa zhodovať s hodnotou tam.
const E2E_MOBIL_EMAIL = "e2e-mobil@forestshop.sk";

// issue 291 (majiteľ: "responzivnost na mobil... mne sa appka na mobile
// nedá zobraziť"). Dohodnutý ZÁKLADNÝ rozsah (viď scoping komentár na
// tickete): menu sa na úzkej obrazovke zbalí samo, horná lišta sa zalomí,
// každá tabuľka dostane vlastný vodorovný posuvný obal namiesto posúvania
// celej stránky. Akceptačný prípad z tiketu: "Sync zo Shoptetu" mala pri
// 375px okne `document.documentElement.scrollWidth` 4085px — jej história
// behov nemala vlastný posuvný obal.
//
// issue 302: predvolená obrazovka po prihlásení sa zmenila zo "Sync zo
// Shoptetu" na "Na objednanie" (`nav.ts`'s `DEFAULT_TAB_ID`) — test teraz
// najprv overí PREDVOLENÚ obrazovku ("Na objednanie", aj tak najhustejšiu
// tabuľku v appke), potom klikne na "Sync zo Shoptetu" a overí AJ tú, presne
// v opačnom poradí ako predtým. Obe obrazovky ostávajú overené, len sa
// zmenilo, ktorá je predvolená.
test("na telefónnej šírke (375px) sa stránka nikdy neposúva vodorovne, panel sa zbalí sám, konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_MOBIL_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // issue 302: predvolená obrazovka po prihlásení je odvtedy "Na
  // objednanie" — tabuľkovo najhustejšia obrazovka v appke (`orders-table-
  // wrap`, mala už VLASTNÝ posuvný obal aj pred issue 291).
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // Bod 1 dohodnutého rozsahu: panel sa na úzkej obrazovke bez uloženej
  // voľby zbalí sám (priamy dôkaz `Sidebar.tsx`'s `initialRail`).
  await expect(page.getByTestId("sidebar-rail-toggle")).toHaveAttribute("aria-expanded", "false");

  // Bod 2: horná lišta sa zalomí — meno prihláseného ostáva DOSIAHNUTEĽNÉ
  // (celé v šírke okna), nie orezané mimo viditeľnú oblasť.
  const greeting = page.getByTestId("greeting");
  await expect(greeting).toBeVisible();
  const greetingBox = await greeting.boundingBox();
  expect(greetingBox).not.toBeNull();
  if (greetingBox !== null) {
    expect(greetingBox.x + greetingBox.width, "meno prihláseného musí byť celé vo viditeľnej šírke").toBeLessThanOrEqual(
      375,
    );
  }

  // Bod 3 + akceptačná kontrola tiketu: žiadne vodorovné posúvanie STRÁNKY.
  const ordersSirky = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(ordersSirky.scrollWidth, "Na objednanie: scrollWidth vs innerWidth pri 375px").toBeLessThanOrEqual(
    ordersSirky.innerWidth,
  );

  // Druhá overená obrazovka — "Sync zo Shoptetu" (akceptačný prípad z
  // tiketu 291: mala pri 375px `document.documentElement.scrollWidth`
  // 4085px — jej história behov nemala vlastný posuvný obal). Záložka je
  // dosiahnuteľná aj v zbalenej lište (prístupný názov prežije,
  // `Sidebar.tsx`'s `railLabel`).
  await page.getByRole("button", { name: "Sync zo Shoptetu" }).click();
  await expect(page.getByRole("heading", { name: "Sync zo Shoptetu" })).toBeVisible();
  const syncSirky = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(syncSirky.scrollWidth, "Sync zo Shoptetu: scrollWidth vs innerWidth pri 375px").toBeLessThanOrEqual(
    syncSirky.innerWidth,
  );

  expect(chyby).toEqual([]);
});
