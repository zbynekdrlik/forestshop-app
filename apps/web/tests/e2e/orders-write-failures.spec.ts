import { expect, test, type ConsoleMessage } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_ZAPISY_EMAIL = "e2e-zapisy@forestshop.sk";

// Rovnaká a JEDINÁ povolená výnimka ako v login.spec.ts/orders.spec.ts.
const jeOcakavane = (m: ConsoleMessage): boolean =>
  m.location().url.includes("/api/me") && m.text().includes("401");

// issue 66: predtým appka zobrazovala len JEDNU (poslednú) chybovú hlášku pri
// zápise do "Na objednanie" — zlyhanie STARŠIEHO riadku úplne zmizlo z
// obrazovky, hoci sa nikdy neuložilo (naživo overené na produkcii PRED
// implementáciou, pozri komentár na tickete #66). Test simuluje DVE
// NEZÁVISLÉ zlyhania zápisu (rôzne riadky, rôzne akcie) cez prepichnutý
// `window.fetch` — injektovaný `addInitScript`om PRED akýmkoľvek appkovým
// kódom, nikdy cez `page.route().abort()`/`.fulfill({status:5xx})`, ktoré by
// zalogovali skutočné "Failed to load resource" do konzoly a porušili
// `.claude/rules/testing.md`'s zákaz rozširovania JEDINEJ povolenej
// konzolovej výnimky (401 na `/api/me`). Žiadny reálny zápis na server preto
// nikdy neodíde — appka naživo nič nemutuje, žiadna nová fixtúra netreba.
test("kumulatívne hlásenie o neuložených zmenách drží VIAC zlyhaní naraz, mizne po úspešnom zápise/zavretí, konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  // Musí bežať PRED appkovým kódom — prvý render volá `fetchOpenOrders` hneď
  // pri mounte. `addInitScript` sa vykoná pred KAŽDÝM ďalším skriptom na
  // stránke.
  await page.addInitScript(() => {
    const puvodny = window.fetch.bind(window);
    const zlyhaj = new Set<string>();
    const uspej = new Set<string>();
    Object.assign(window, { __zlyhajUrl: zlyhaj, __uspejUrl: uspej });
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method;
      if (method !== undefined && method !== "GET") {
        for (const frag of zlyhaj) {
          if (url.includes(frag)) return Promise.reject(new TypeError("Failed to fetch (simulovaný výpadok siete)"));
        }
        for (const frag of uspej) {
          if (url.includes(frag)) {
            return Promise.resolve(
              new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
            );
          }
        }
      }
      return puvodny(input, init);
    };
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill(E2E_ZAPISY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  const riadokAlfa = page
    .getByTestId("supplier-DODAVATEL-TEST-1")
    .locator("[data-testid^='order-line-']")
    .filter({ hasText: "9001" });
  // issue 161: `<select>` nahradili 4 tlačidlá — obal so skupinovým testid
  // (`state-select-<lineId>`, teraz `role="radiogroup"`) sa použije LEN na
  // vyčítanie `lineId`, samotná zmena ide cez konkrétne `role="radio"` tlačidlo.
  const stavGroupAlfa = riadokAlfa.locator("[data-testid^='state-select-']");
  const tlacidloCakaSaAlfa = riadokAlfa.getByRole("radio", { name: "Čaká sa" });
  const tlacidloSkladomAlfa = riadokAlfa.getByRole("radio", { name: "Skladom" });

  const riadokBez = page
    .getByTestId("supplier-(bez dodávateľa)")
    .locator("[data-testid^='order-line-']")
    .filter({ hasText: "9002" });
  const checkboxBez = riadokBez.locator("input[type='checkbox']");

  const alfaTestId = await stavGroupAlfa.getAttribute("data-testid");
  const alfaLineId = (alfaTestId ?? "").replace("state-select-", "");
  const bezTestId = await checkboxBez.getAttribute("data-testid");
  const bezLineId = (bezTestId ?? "").replace("ordered-checkbox-", "");
  expect(alfaLineId).not.toBe("");
  expect(bezLineId).not.toBe("");

  const banner = page.getByTestId("order-write-failures");

  // `scripts/e2e-setup.ts`: riadok Alfa (obj. 9001) štartuje v stave
  // "caka_sa" (vybavený), nie vo východiskovom "objednane".
  await expect(tlacidloCakaSaAlfa).toHaveAttribute("aria-checked", "true");

  // 1. zlyhanie: zmena stavu na riadku Alfa (DODAVATEL-TEST-1, obj. 9001).
  await page.evaluate((frag) => {
    (window as unknown as { __zlyhajUrl: Set<string> }).__zlyhajUrl.add(frag);
  }, `/api/orders/lines/${alfaLineId}/state`);
  await tlacidloSkladomAlfa.click();
  await expect(banner).toContainText("Nepodarilo sa uložiť 1 položku");
  await expect(banner).toContainText("obj. 9001");
  // Zamietnutá zmena sa NIKDY netvári ako uložená.
  await expect(tlacidloCakaSaAlfa).toHaveAttribute("aria-checked", "true");

  // 2. NEZÁVISLÉ zlyhanie: iný riadok (obj. 9002, "(bez dodávateľa)"), iná
  // akcia (checkbox "objednané").
  await page.evaluate((frag) => {
    (window as unknown as { __zlyhajUrl: Set<string> }).__zlyhajUrl.add(frag);
  }, `/api/orders/lines/${bezLineId}/ordered`);
  await checkboxBez.click();
  await expect(banner).toContainText("Nepodarilo sa uložiť 2 položky");
  // PRVÉ zlyhanie stále vidieť — presne to, čo ticket #66 vyžaduje (predtým
  // by ho toto druhé zlyhanie ÚPLNE prepísalo).
  await expect(banner).toContainText("obj. 9001");
  await expect(banner).toContainText("obj. 9002");
  await expect(checkboxBez).not.toBeChecked();

  // Úspešný opakovaný zápis (riadok Alfa, mockovaná 200 odpoveď — žiadny
  // reálny zápis na server) zmaže LEN jeho položku z bannera.
  await page.evaluate((frag) => {
    const w = window as unknown as { __zlyhajUrl: Set<string>; __uspejUrl: Set<string> };
    w.__zlyhajUrl.delete(frag);
    w.__uspejUrl.add(frag);
  }, `/api/orders/lines/${alfaLineId}/state`);
  await tlacidloSkladomAlfa.click();
  await expect(banner).toContainText("Nepodarilo sa uložiť 1 položku");
  await expect(banner).not.toContainText("obj. 9001");
  await expect(banner).toContainText("obj. 9002");

  // Zatvorenie bannera zmaže VŠETKY zostávajúce položky naraz.
  await page.getByRole("button", { name: "Zavrieť hlásenie o neuložených zmenách" }).click();
  await expect(banner).toHaveCount(0);

  expect(chyby).toEqual([]);
});
