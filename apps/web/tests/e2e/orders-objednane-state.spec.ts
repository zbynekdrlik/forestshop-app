import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// issue 493: prihlasujeme sa pod účtom, ktorý už seeduje `scripts/e2e-setup.ts`
// (`E2E_OBJEDNANE_EMAIL`, dnes používaný `orders.spec.ts`) — tento test len
// PRIDÁVA jedno prihlásenie (spolu 2, ďaleko pod `MAX_ATTEMPTS=10` na (IP,e-mail)
// pár), NEMENÍ heslo ani žiadne zdieľané dáta (board je celý mocknutý nižšie),
// takže nový samostatný účet (a riziko prekročenia 400-riadkového limitu
// `e2e-setup.ts`) netreba.
const E2E_OBJEDNANE_EMAIL = "e2e-objednane@forestshop.sk";

// issue 493: šiesty EXKLUZÍVNY stav klastra „Objednané" (interná hodnota
// `objednane_stav`, NIE `objednane` = default „Nemáme") na hlavnej tabuľke
// „Na objednanie" — klik-flow s kontrolou nulovej konzoly.
//
// Prečo prepichnutý `window.fetch` (`addInitScript`), nie reálne seedované dáta:
// `orders.spec.ts`'s prvý test asertuje PRESNÉ GLOBÁLNE počty otvorených riadkov
// naprieč VŠETKÝMI dodávateľmi, takže akákoľvek reálne seedovaná objednávka by
// tie čísla rozbila, a mutovanie zdieľaných objednávok medzi paralelnými spec
// súbormi je race (`.claude/rules/frontend-design.md`, rovnaký vzor ako
// `riesit.spec.ts`/`orders-write-failures.spec.ts`). Mockneme LEN board
// (`GET /api/orders/open`) vlastnou fixtúrou a zápis stavu
// (`POST /api/orders/lines/:id/state`); zvyšok (login, `/api/me`, prehľad,
// odznaky) ide reálne. JS-level override NEloguje „Failed to load resource"
// (na rozdiel od `page.route`), takže konzola ostáva čistá. Reálny endpoint
// end-to-end pokrýva `apps/api/tests/orders-http-state.integration.test.ts`;
// poradie a klik komponentu `OrderLineStateButtons.test.tsx`.
const FAKE_LINE_ID = "e2e00000-0000-0000-0000-000000000493";

test("Na objednanie: klik na Objednané prepne riadok do 6. stavu (objednane_stav), tlačidlo sa rozsvieti a predvolené zhasne, konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  // Musí bežať PRED appkovým kódom — prvý render volá `fetchOpenOrders` hneď
  // pri mounte. `addInitScript` sa vykoná pred KAŽDÝM ďalším skriptom stránky.
  await page.addInitScript((lineId: string) => {
    const puvodny = window.fetch.bind(window);
    const skupina = {
      supplier: "DODAVATEL-OBJEDNANE-493",
      email: null,
      lines: [
        {
          lineId,
          orderId: "e2e00000-0000-0000-0000-000000004930",
          externalOrderId: "7493",
          customerName: "Zákazník Objednané",
          comment: null,
          remark: null,
          shopRemark: null,
          adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=7493&src=orders",
          placedAt: "2026-08-01T00:00:00.000Z",
          variantCode: "OBJ-1",
          variantName: "Produkt na objednanie",
          sizeLabel: null,
          ourUrl: null,
          quantity: 1,
          state: "objednane",
          ordered: false,
          supplierUrl: null,
          supplierNote: null,
          externalCode: null,
          supplierAssignable: false,
          manualSupplierOverride: null,
          customerOpenOrderCount: 1,
        },
      ],
    };
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const cesta = url.replace(/\?.*$/, "");
      const method = init?.method ?? "GET";
      // POZOR: `/api/orders/open-statuses` je iný endpoint — preto `endsWith`,
      // nie `includes` (to by chytilo aj open-statuses/overview).
      if (method === "GET" && cesta.endsWith("/api/orders/open")) {
        return Promise.resolve(json({ suppliers: [skupina] }));
      }
      if (method !== "GET" && cesta.includes("/api/orders/lines/") && cesta.endsWith("/state")) {
        const telo = typeof init?.body === "string" ? init.body : "{}";
        const st = (JSON.parse(telo) as { state?: string }).state ?? "";
        // Zapíš DRÔTOVÚ hodnotu, aby test overil, že tlačidlo poslalo internú
        // `objednane_stav`, nie label ani default `objednane` (vzor `__zlyhajUrl`
        // v orders-write-failures.spec.ts).
        Object.assign(window, { __sentState: st });
        // Verné reálnemu serveru: 200 `{ok:true, state}` (route je generická,
        // `z.enum(orderLineState.enumValues)`).
        return Promise.resolve(json({ ok: true, state: st }));
      }
      return puvodny(input, init);
    };
  }, FAKE_LINE_ID);

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill(E2E_OBJEDNANE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // Titulok „Na objednanie" renderuje Topbar (viditeľná záložka).
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // 6. tlačidlo „Objednané" (interná hodnota `objednane_stav`) je súčasťou
  // klastra; `getByTestId` je PRESNÁ zhoda, takže `state-btn-objednane-<id>`
  // (Nemáme) a `state-btn-objednane_stav-<id>` (Objednané) sa nemiešajú.
  const objednaneBtn = page.getByTestId(`state-btn-objednane_stav-${FAKE_LINE_ID}`);
  const nevybaveneBtn = page.getByTestId(`state-btn-objednane-${FAKE_LINE_ID}`);
  await expect(objednaneBtn).toBeVisible();
  await expect(objednaneBtn).toHaveText("Objednané");

  // Východiskovo je aktívny predvolený stav „Nemáme", nie „Objednané".
  await expect(nevybaveneBtn).toHaveAttribute("aria-checked", "true");
  await expect(objednaneBtn).toHaveAttribute("aria-checked", "false");

  // Klik na „Objednané" → exkluzívny radio: 6. stav sa rozsvieti, predvolený
  // zhasne. `toHaveAttribute` opakuje, kým sa lokálny update po vyriešení
  // promisu zápisu prejaví (rovnaký princíp ako `.toBeChecked()` inde).
  await objednaneBtn.click();
  await expect(objednaneBtn).toHaveAttribute("aria-checked", "true");
  await expect(nevybaveneBtn).toHaveAttribute("aria-checked", "false");

  // review 🔵: over aj skutočnú DRÔTOVÚ hodnotu poslanú na server — musí byť
  // interná `objednane_stav`, NIE label „Objednané" ani default `objednane`.
  const poslanyStav = await page.evaluate(() => (window as unknown as { __sentState?: string }).__sentState);
  expect(poslanyStav).toBe("objednane_stav");

  expect(chyby).toEqual([]);
});

// issue 579 (Štěpán): východiskový stav riadku je NEOZNAČENÝ (NULL) — žiadne
// tlačidlo nie je aktívne; „Nemáme" (objednane) je červené; klik ho uloží a po
// reloade drží. Board je STAVOVO mocknutý cez `localStorage` (POST zapíše stav,
// reload ho z neho prečíta), takže reload-perzistencia je deterministická bez
// dotyku zdieľaných seed dát (rovnaký dôvod ako prvý test v tomto súbore).
const FAKE_LINE_ID_579 = "e2e00000-0000-0000-0000-000000000579";

test("Na objednanie: neoznačený riadok nemá aktívne tlačidlo, „Nemáme“ je červené, klik uloží a drží po reloade, konzola čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.addInitScript((lineId: string) => {
    const puvodny = window.fetch.bind(window);
    const KEY = "e2e579-state";
    const readState = (): string | null => {
      const raw = window.localStorage.getItem(KEY);
      return raw === null || raw === "null" ? null : raw;
    };
    const skupina = () => ({
      supplier: "DODAVATEL-579",
      email: null,
      lines: [
        {
          lineId,
          orderId: "e2e00000-0000-0000-0000-000000005790",
          externalOrderId: "7579",
          customerName: "Zákazník 579",
          comment: null,
          remark: null,
          shopRemark: null,
          adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=7579&src=orders",
          placedAt: "2026-08-01T00:00:00.000Z",
          variantCode: "OBJ-579",
          variantName: "Produkt bez stavu",
          sizeLabel: null,
          ourUrl: null,
          quantity: 1,
          state: readState(),
          ordered: false,
          supplierUrl: null,
          supplierNote: null,
          externalCode: null,
          supplierAssignable: false,
          manualSupplierOverride: null,
          customerOpenOrderCount: 1,
        },
      ],
    });
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const cesta = url.replace(/\?.*$/, "");
      const method = init?.method ?? "GET";
      if (method === "GET" && cesta.endsWith("/api/orders/open")) {
        return Promise.resolve(json({ suppliers: [skupina()] }));
      }
      if (method !== "GET" && cesta.includes("/api/orders/lines/") && cesta.endsWith("/state")) {
        const telo = typeof init?.body === "string" ? init.body : "{}";
        const st = (JSON.parse(telo) as { state?: string }).state ?? "";
        window.localStorage.setItem(KEY, st);
        return Promise.resolve(json({ ok: true, state: st }));
      }
      return puvodny(input, init);
    };
  }, FAKE_LINE_ID_579);

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill(E2E_OBJEDNANE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  const nemBtn = page.getByTestId(`state-btn-objednane-${FAKE_LINE_ID_579}`);
  await expect(nemBtn).toBeVisible();
  await expect(nemBtn).toHaveText("Nemáme");

  // Východiskovo (NULL) NIE JE aktívne žiadne tlačidlo klastra.
  const aktivnych = await page
    .getByTestId(`state-select-${FAKE_LINE_ID_579}`)
    .locator('[aria-checked="true"]')
    .count();
  expect(aktivnych).toBe(0);

  // „Nemáme" je červené (`--fs-danger`) už v neoznačenom stave — porovnáme
  // computed color s hodnotou tokenu prečítanou zo `:root` (nie natvrdo hex).
  const farby1 = await page.evaluate((id: string) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--fs-danger)";
    document.body.appendChild(probe);
    const danger = getComputedStyle(probe).color;
    probe.remove();
    const btn = document.querySelector(`[data-testid="state-btn-objednane-${id}"]`);
    return { danger, btn: btn === null ? "" : getComputedStyle(btn).color };
  }, FAKE_LINE_ID_579);
  expect(farby1.btn).toBe(farby1.danger);

  // Klik na „Nemáme" → aktívne (exkluzívne), stále červené.
  await nemBtn.click();
  await expect(nemBtn).toHaveAttribute("aria-checked", "true");

  // Po reloade stav DRŽÍ (mock ho číta z localStorage) — tlačidlo ostáva aktívne.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  const nemBtnPoReloade = page.getByTestId(`state-btn-objednane-${FAKE_LINE_ID_579}`);
  await expect(nemBtnPoReloade).toHaveAttribute("aria-checked", "true");
  const farby2 = await page.evaluate((id: string) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--fs-danger)";
    document.body.appendChild(probe);
    const danger = getComputedStyle(probe).color;
    probe.remove();
    const btn = document.querySelector(`[data-testid="state-btn-objednane-${id}"]`);
    return { danger, btn: btn === null ? "" : getComputedStyle(btn).color };
  }, FAKE_LINE_ID_579);
  expect(farby2.btn).toBe(farby2.danger);

  expect(chyby).toEqual([]);
});
