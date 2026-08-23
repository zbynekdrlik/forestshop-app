import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_RIESIT_EMAIL = "e2e-riesit@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 476: sekcia „Riešiť" — klik-flow (riadok v stave riesit sa zobrazí,
// zmena stavu ho odstráni), menu odznak, rýchle pole a nulová konzola.
//
// Prečo prepichnutý `window.fetch` (`addInitScript`), nie reálne seedované
// dáta: `orders.spec.ts`'s prvý test asertuje PRESNÉ GLOBÁLNE počty otvorených
// riadkov („Všetci (9)", „Ostáva vybaviť 9 z 13") naprieč VŠETKÝMI dodávateľmi
// — akákoľvek reálne seedovaná objednávka by tie čísla rozbila, a mutovanie
// zdieľaných objednávok medzi paralelnými spec súbormi je race
// (`.claude/rules/frontend-design.md`). JS-level override `window.fetch`
// (rovnaký vzor ako `orders-write-failures.spec.ts`) nič v zdieľanej DB
// nemení, je retry-safe a NEloguje „Failed to load resource" do konzoly (na
// rozdiel od `page.route`, ktorý ide cez reálnu sieť). Reálny endpoint
// end-to-end pokrýva `apps/api/tests/riesit-http.integration.test.ts`; reálny
// komponent+hook `apps/web/src/components/RiesitSection.test.tsx`.
const FAKE_LINE_ID = "e2e00000-0000-0000-0000-000000000476";

test("Riešiť: riadok sa zobrazí, zmena stavu ho odstráni, odznak svieti, rýchle pole hlási neznáme číslo, konzola je čistá", async ({
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
    const skupina = {
      supplier: "DODAVATEL-RIESIT",
      email: null,
      lines: [
        {
          lineId,
          orderId: "e2e00000-0000-0000-0000-0000000004aa",
          externalOrderId: "7001",
          customerName: "Zákazník Riešiť",
          comment: null,
          remark: null,
          shopRemark: null,
          adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=7001&src=orders",
          placedAt: "2026-08-01T00:00:00.000Z",
          variantCode: "R-1",
          variantName: "Produkt na riešenie",
          sizeLabel: null,
          ourUrl: null,
          quantity: 1,
          state: "riesit",
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
      const method = init?.method ?? "GET";
      if (url.includes("/api/orders/riesit/count")) return Promise.resolve(json({ count: 1 }));
      if (url.includes("/api/orders/riesit/by-code")) {
        const telo = typeof init?.body === "string" ? init.body : "{}";
        const code = (JSON.parse(telo) as { code?: string }).code ?? "";
        // Neznáme číslo = 200 `{ok:false,error}` (NIE 4xx) — verné reálnemu
        // serveru, aby konzola ostala čistá (viď server komentár / testing.md).
        if (code === "9999") return Promise.resolve(json({ ok: false, error: `Objednávka s číslom „${code}“ sa nenašla.` }));
        return Promise.resolve(json({ ok: true, lineCount: 1 }));
      }
      if (url.includes("/api/orders/riesit")) return Promise.resolve(json({ suppliers: [skupina] }));
      if (method !== "GET" && url.includes("/api/orders/lines/") && url.includes("/state")) {
        return Promise.resolve(json({ ok: true, state: "skladom" }));
      }
      return puvodny(input, init);
    };
  }, FAKE_LINE_ID);

  await page.goto("/?tab=riesit");
  await page.getByLabel("E-mail").fill(E2E_RIESIT_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // Titulok „Riešiť" renderuje Topbar (viditeľná záložka, `.claude/rules/frontend-design.md`).
  await expect(page.getByRole("heading", { name: "Riešiť" })).toBeVisible();

  // Riadok v stave riesit sa zobrazí, jeho tlačidlo „Riešiť" je aktívne.
  const riadok = page.getByTestId(`order-line-${FAKE_LINE_ID}`);
  await expect(riadok).toBeVisible();
  await expect(page.getByTestId(`state-btn-riesit-${FAKE_LINE_ID}`)).toHaveAttribute("aria-checked", "true");

  // Menu odznak „Riešiť" svieti kladným číslom (nie presná hodnota — zdieľaný
  // stav, `.claude/rules/frontend-design.md`, vzor issue 445).
  await expect(page.getByTestId("nav-badge-riesit")).toHaveText(/^\d+$/);

  // Rýchle pole je viditeľné.
  await expect(page.getByTestId("riesit-quick-add-input")).toBeVisible();

  // Zmena stavu na iný → riadok zo sekcie zmizne (optimistické odstránenie).
  await page.getByTestId(`state-btn-skladom-${FAKE_LINE_ID}`).click();
  await expect(riadok).toHaveCount(0);

  // Rýchle pole: neznáme číslo → zrozumiteľná chyba.
  await page.getByTestId("riesit-quick-add-input").fill("9999");
  await page.getByTestId("riesit-quick-add-submit").click();
  await expect(page.getByTestId("riesit-quick-add-error")).toContainText("nenašla");

  expect(chyby).toEqual([]);
});
