import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// issue 500/502: znovupoužívame izolovaný účet `riesit.spec.ts` (jediný ďalší
// spec, ktorý sa naň prihlasuje) — 2 prihlásenia na (IP, e-mail) pár, ďaleko
// pod `MAX_ATTEMPTS=10`, takže netreba nový seedovaný účet.
const E2E_EMAIL = "e2e-riesit@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 500/502: @ tlačidlo (e-mail zákazníkovi) na riadku „Na objednanie" AJ
// „Riešiť" — klik-flow. Prečo prepichnutý `window.fetch` (`addInitScript`), nie
// reálne seedované dáta: `orders.spec.ts` asertuje PRESNÉ globálne počty riadkov
// a mutovanie zdieľaných objednávok medzi paralelnými spec súbormi je race
// (`.claude/rules/frontend-design.md`, vzor `riesit.spec.ts`/`orders-write-
// failures.spec.ts`). JS-level override nič v DB nemení, je retry-safe a
// NEloguje „Failed to load resource" do konzoly (na rozdiel od `page.route`).
// Skutočná preview/send cesta end-to-end je pokrytá
// `apps/api/tests/order-customer-contact.integration.test.ts`; reálny
// komponent+hook `OrdersSection.customerContact.test.tsx`/
// `RiesitSection.customerContact.test.tsx`.
const FAKE_LINE_ID = "e2e00000-0000-0000-0000-000000000500";

test("@ e-mail zákazníkovi: klik na riadku Na objednanie aj Riešiť otvorí okno predvyplnené menom + číslom objednávky, konzola je čistá", async ({
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
    const line = {
      lineId,
      orderId: "e2e00000-0000-0000-0000-0000000005aa",
      externalOrderId: "9500",
      customerName: "E2E Kontakt Zákazník",
      comment: null,
      remark: null,
      shopRemark: null,
      adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=9500&src=orders",
      placedAt: "2026-08-20T00:00:00.000Z",
      variantCode: "K-1",
      variantName: "Kontaktný produkt",
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
    };
    const naObjednanieGroup = { supplier: "DODAVATEL-KONTAKT", email: null, lines: [line] };
    const riesitGroup = {
      supplier: "DODAVATEL-KONTAKT-RIESIT",
      email: null,
      lines: [{ ...line, lineId: "e2e00000-0000-0000-0000-000000000501", orderId: "e2e00000-0000-0000-0000-0000000005bb", externalOrderId: "9501", customerName: "E2E Riešiť Zákazník", state: "riesit" }],
    };
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/orders/open")) return Promise.resolve(json({ suppliers: [naObjednanieGroup] }));
      if (url.includes("/api/orders/riesit/count")) return Promise.resolve(json({ count: 1 }));
      if (url.includes("/api/orders/riesit")) return Promise.resolve(json({ suppliers: [riesitGroup] }));
      if (url.includes("/api/order-customer-contact/preview")) {
        const telo = typeof init?.body === "string" ? init.body : "{}";
        const code = (JSON.parse(telo) as { orderCode?: string }).orderCode ?? "";
        const meno = code === "9501" ? "E2E Riešiť Zákazník" : "E2E Kontakt Zákazník";
        return Promise.resolve(
          json({
            ok: true,
            subject: `Vaša objednávka č. ${code} — Forestshop.sk`,
            html: "<p>náhľad</p>",
            text: `Dobrý deň, ${meno},\n\nRadi by sme Vás kontaktovali ohľadom Vašej objednávky č. ${code}.\n\nS pozdravom,\nDrlík, Forestshop.sk`,
            recipient: "kontakt@example.sk",
            customerName: meno,
            previewToken: "e2etok",
          }),
        );
      }
      return puvodny(input, init);
    };
  }, FAKE_LINE_ID);

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill(E2E_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // „Na objednanie": @ tlačidlo na riadku otvorí okno predvyplnené menom +
  // číslom objednávky (telo je `<textarea>` — hodnotu treba čítať cez
  // `toHaveValue`, nikdy text-content, `.claude/rules/nedostupne.md`).
  await page.getByTestId(`customer-contact-open-${FAKE_LINE_ID}`).click();
  await expect(page.getByTestId("customer-contact-preview")).toBeVisible();
  await expect(page.getByTestId("customer-contact-preview")).toContainText("kontakt@example.sk");
  const bodyNaObjednanie = page.getByTestId("customer-contact-preview-body");
  await expect(bodyNaObjednanie).toHaveValue(/E2E Kontakt Zákazník/);
  await expect(bodyNaObjednanie).toHaveValue(/9500/);
  await page.getByTestId("customer-contact-preview-cancel").click();
  await expect(page.getByTestId("customer-contact-preview")).toHaveCount(0);

  // „Riešiť": to isté @ tlačidlo za menom zákazníka na kompaktnom riadku.
  await page.getByTestId("nav-tab-riesit").click();
  await expect(page.getByRole("heading", { name: "Riešiť" })).toBeVisible();
  await expect(page.getByTestId("riesit-order-9501")).toContainText("E2E Riešiť Zákazník");

  await page.getByTestId("customer-contact-open-9501").click();
  await expect(page.getByTestId("customer-contact-preview")).toBeVisible();
  const bodyRiesit = page.getByTestId("customer-contact-preview-body");
  await expect(bodyRiesit).toHaveValue(/E2E Riešiť Zákazník/);
  await expect(bodyRiesit).toHaveValue(/9501/);
  await page.getByTestId("customer-contact-preview-cancel").click();
  await expect(page.getByTestId("customer-contact-preview")).toHaveCount(0);

  expect(chyby).toEqual([]);
});
