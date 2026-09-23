import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_OBJEDNAVKY_VYMENA_EMAIL = "e2e-vymena@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-fixtures-order-flags.ts

// issue 290: "Eshop → Výmena tovaru / Vrátený tovar / Reklamácie" — tri nové
// READ-ONLY stránky pod "Nedostupné tovary" + odznaky počtu v ľavom menu.
// Fixtúrové objednávky "9201"–"9204" (`scripts/e2e-fixtures-order-flags.ts`)
// patria VÝHRADNE tomuto spec súboru — žiadny iný spec s nimi nepracuje.
// "unresolved" (otvorená vratenie karta) NEMÁ e2e pokrytie — `upozornenie`
// je globálna tabuľka zdieľaná so `upozornenia.spec.ts` (jeho "žiadne
// upozornenia" prázdny stav), rovnaká past ako `.claude/rules/posta-
// uncollected.md`'s zamietnutý pokus pri issue 298; tú logiku pokrýva
// `order-flags-http.integration.test.ts` (izolovaná DB) + `ExchangeOrdersSection
// .test.tsx` (mock).
test("Výmena tovaru/Vrátený tovar zobrazia zoznam, Reklamácie umožnia označiť a zrušiť s odznakom v menu, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_OBJEDNAVKY_VYMENA_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // Reklamácie majú aspoň jednu (9203, pred-označená fixtúrou) — odznak
  // počtu je preto viditeľný hneď po prihlásení, ešte pred otvorením
  // záložky (rovnaký vzor ako "Upozornenia"/"Na objednanie").
  const claimsOdznak = page.getByTestId("nav-badge-claims");
  await expect(claimsOdznak).toBeVisible();
  await expect(claimsOdznak).toHaveText(/^\d+$/);

  // issue 514: menu-odznak „Výmena tovaru" = počet AKTÍVnych výmen (stav
  // „Výmena tovaru"). Fixtúra 9201 garantuje ≥1, takže odznak je viditeľný
  // hneď po prihlásení (skrytý pri 0). Presné číslo NEasertujeme — badge
  // počíta VŠETKY „Výmena tovaru" objednávky v zdieľanej seed DB (vzor
  // issue 445, `nav-badge` disciplína).
  const vymenaOdznak = page.getByTestId("nav-badge-exchange");
  await expect(vymenaOdznak).toBeVisible();
  await expect(vymenaOdznak).toHaveText(/^[1-9]\d*$/);

  // issue 516: menu-odznak „Vrátený tovar" = počet AKTÍVnych vrátení (stav
  // „Vratený tovar"), zdieľa TÚ istú dátovú cestu ako výpis (badge == výpis).
  // Fixtúra 9202 garantuje ≥1, takže odznak je viditeľný hneď po prihlásení
  // (skrytý pri 0). Presné číslo NEasertujeme — badge počíta VŠETKY „Vratený
  // tovar" objednávky v zdieľanej seed DB (vzor issue 445, `nav-badge` disciplína).
  const vrateniOdznak = page.getByTestId("nav-badge-returned");
  await expect(vrateniOdznak).toBeVisible();
  await expect(vrateniOdznak).toHaveText(/^[1-9]\d*$/);

  // issue 583: Štěpán (Discord Develop-ÚLOHY, 22. 9. 2026) — počítadlá „Výmena
  // tovaru" a „Vrátený tovar" sú ČERVENÉ s bielym číslom, červená = tá istá,
  // akú používa „Na objednanie" (`--fs-danger`, aktívne Nedostupné/Nemáme);
  // „zmen to len pri tychto dvoch položkách" — `nav-badge-orders` ostáva v
  // brand zelenej (`--fs-brand`). Farby tokenov sa čítajú sondou (vzor
  // `orders-objednane-state.spec.ts`), nie ako raw hex, aby test prežil zmenu
  // odtieňa tokenu. Presné čísla sa naďalej NEasertujú (issue 445 disciplína).
  // Odznak „Na objednanie" príde až po mounte sekcie (context, issue 147) —
  // najprv počkať, kým existuje, potom čítať farby všetkých troch naraz.
  await expect(page.getByTestId("nav-badge-orders")).toBeVisible();
  const farbyOdznakov = await page.evaluate(() => {
    const sonda = (token: string): string => {
      const el = document.createElement("span");
      el.style.color = token;
      document.body.appendChild(el);
      const farba = getComputedStyle(el).color;
      el.remove();
      return farba;
    };
    const odznak = (testid: string): { bg: string; fg: string } => {
      const el = document.querySelector(`[data-testid="${testid}"]`);
      return el === null ? { bg: "", fg: "" } : { bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color };
    };
    return {
      danger: sonda("var(--fs-danger)"),
      brand: sonda("var(--fs-brand)"),
      exchange: odznak("nav-badge-exchange"),
      returned: odznak("nav-badge-returned"),
      orders: odznak("nav-badge-orders"),
    };
  });
  // Sonda musí rozlíšiť oba tokeny — inak by rovnosť nižšie nič nedokazovala.
  expect(farbyOdznakov.danger).not.toBe(farbyOdznakov.brand);
  expect(farbyOdznakov.exchange).toEqual({ bg: farbyOdznakov.danger, fg: "rgb(255, 255, 255)" });
  expect(farbyOdznakov.returned).toEqual({ bg: farbyOdznakov.danger, fg: "rgb(255, 255, 255)" });
  expect(farbyOdznakov.orders).toEqual({ bg: farbyOdznakov.brand, fg: "rgb(255, 255, 255)" });

  // Výmena tovaru.
  await page.getByRole("button", { name: "Výmena tovaru" }).click();
  await expect(page.getByRole("heading", { name: "Výmena tovaru" })).toBeVisible();
  const vymenaRiadok = page.getByTestId("exchange-row-9201");
  await expect(vymenaRiadok).toBeVisible();
  await expect(vymenaRiadok).toContainText("E2E Zákazník Výmena");
  await expect(vymenaRiadok).toContainText("Výmena tovaru");
  await expect(vymenaRiadok).toContainText("30.00 €");

  // Vrátený tovar.
  await page.getByRole("button", { name: "Vrátený tovar" }).click();
  await expect(page.getByRole("heading", { name: "Vrátený tovar" })).toBeVisible();
  const vrateniRiadok = page.getByTestId("returned-row-9202");
  await expect(vrateniRiadok).toBeVisible();
  await expect(vrateniRiadok).toContainText("E2E Zákazník Vrátenie");
  await expect(vrateniRiadok).toContainText("Vratený tovar");

  // Reklamácie — 9203 je vopred označená fixtúrou.
  await page.getByRole("button", { name: "Reklamácie" }).click();
  await expect(page.getByRole("heading", { name: "Reklamácie" })).toBeVisible();
  const reklamaciaRiadok = page.getByTestId("claim-row-9203");
  await expect(reklamaciaRiadok).toBeVisible();
  await expect(reklamaciaRiadok).toContainText("e2e — vopred označená reklamácia");

  // Označenie NOVEJ reklamácie (9204, doteraz neoznačená) — celý zápisový
  // cyklus vrátane odznaku v menu.
  await page.getByTestId("claim-order-code").fill("9204");
  await page.getByTestId("claim-note-input").fill("e2e — nová reklamácia");
  await page.getByTestId("claim-mark-submit").click();
  const novaRiadok = page.getByTestId("claim-row-9204");
  await expect(novaRiadok).toBeVisible();
  await expect(novaRiadok).toContainText("e2e — nová reklamácia");
  await expect(claimsOdznak).toHaveText(/^\d+$/);

  // Zrušenie tej istej reklamácie — riadok zmizne.
  await page.getByTestId("claim-clear-9204").click();
  await expect(page.getByTestId("claim-row-9204")).toBeHidden();
  // Vopred označená 9203 ostáva nedotknutá.
  await expect(page.getByTestId("claim-row-9203")).toBeVisible();

  expect(chyby).toEqual([]);
});
