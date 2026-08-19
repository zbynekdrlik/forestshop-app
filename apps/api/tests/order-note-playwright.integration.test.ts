import { afterEach, describe, expect, it } from "vitest";
import { runOrderNoteWriteback, runOrderNoteWritebackIsolated } from "../src/modules/shoptet-writeback/order-note-playwright.js";
import { startOrderDetailFixture, type OrderDetailFixture } from "./helpers/shoptet-order-detail-fixture.js";

// Reálny Chromium proti LOKÁLNEJ fixture appke (nikdy proti skutočnému
// Shoptetu — rovnaká testová požiadavka ako #122). Browser beh môže byť
// pomalší v CI, preto vyšší timeout než ostatné integračné testy.
const TEST_TIMEOUT_MS = 120_000; // issue 460: realny Chromium (~16 s baseline) proti fixture + premenlivy CI runner — rezerva ~8x, nie band-aid (merane zo surodencov, nie odhad)

describe("runOrderNoteWriteback (proti fixture, nikdy proti reálnemu Shoptetu)", () => {
  let fixture: OrderDetailFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it(
    "appends our block to an EMPTY shopRemark and confirms via fresh navigation",
    async () => {
      fixture = await startOrderDetailFixture({ user: "manager", password: "tajneheslo" });

      const results = await runOrderNoteWriteback({
        config: { loginUrl: `${fixture.baseUrl}/admin/`, adminBaseUrl: fixture.baseUrl, user: "manager", password: "tajneheslo" },
        orders: [{ orderId: "order-1", externalOrderId: "20261273", shoptetOrderId: 59783, comment: "Zavolať zajtra" }],
      });

      expect(results).toEqual([{ orderId: "order-1", externalOrderId: "20261273", ok: true, errorDetail: null }]);
      expect(fixture.getShopRemark(59783)).toBe("--- poznámka z appky ---\nZavolať zajtra\n--- koniec ---");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "preserves manual shop text, appending our block after it (never overwrites)",
    async () => {
      fixture = await startOrderDetailFixture({ user: "manager", password: "tajneheslo" });
      fixture.seedShopRemark(59783, "Ručne napísaná poznámka predajne");

      const results = await runOrderNoteWriteback({
        config: { loginUrl: `${fixture.baseUrl}/admin/`, adminBaseUrl: fixture.baseUrl, user: "manager", password: "tajneheslo" },
        orders: [{ orderId: "order-1", externalOrderId: "20261273", shoptetOrderId: 59783, comment: "Zavolať zajtra" }],
      });

      expect(results[0]?.ok).toBe(true);
      expect(fixture.getShopRemark(59783)).toBe(
        "Ručne napísaná poznámka predajne\n\n--- poznámka z appky ---\nZavolať zajtra\n--- koniec ---",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "replaces ONLY our block on a resync, still keeping the manual text",
    async () => {
      fixture = await startOrderDetailFixture({ user: "manager", password: "tajneheslo" });
      fixture.seedShopRemark(
        59783,
        "Ručná poznámka\n\n--- poznámka z appky ---\nStará poznámka\n--- koniec ---",
      );

      const results = await runOrderNoteWriteback({
        config: { loginUrl: `${fixture.baseUrl}/admin/`, adminBaseUrl: fixture.baseUrl, user: "manager", password: "tajneheslo" },
        orders: [{ orderId: "order-1", externalOrderId: "20261273", shoptetOrderId: 59783, comment: "Nová poznámka" }],
      });

      expect(results[0]?.ok).toBe(true);
      expect(fixture.getShopRemark(59783)).toBe(
        "Ručná poznámka\n\n--- poznámka z appky ---\nNová poznámka\n--- koniec ---",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "removes ONLY our block when the app comment was cleared, keeping manual text",
    async () => {
      fixture = await startOrderDetailFixture({ user: "manager", password: "tajneheslo" });
      fixture.seedShopRemark(
        59783,
        "Ručná poznámka\n\n--- poznámka z appky ---\nStará poznámka\n--- koniec ---",
      );

      const results = await runOrderNoteWriteback({
        config: { loginUrl: `${fixture.baseUrl}/admin/`, adminBaseUrl: fixture.baseUrl, user: "manager", password: "tajneheslo" },
        orders: [{ orderId: "order-1", externalOrderId: "20261273", shoptetOrderId: 59783, comment: null }],
      });

      expect(results[0]?.ok).toBe(true);
      expect(fixture.getShopRemark(59783)).toBe("Ručná poznámka");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "processes MULTIPLE orders in one login session, all succeeding",
    async () => {
      fixture = await startOrderDetailFixture({ user: "manager", password: "tajneheslo" });

      const results = await runOrderNoteWriteback({
        config: { loginUrl: `${fixture.baseUrl}/admin/`, adminBaseUrl: fixture.baseUrl, user: "manager", password: "tajneheslo" },
        orders: [
          { orderId: "order-1", externalOrderId: "20261273", shoptetOrderId: 59783, comment: "Prvá poznámka" },
          { orderId: "order-2", externalOrderId: "20261272", shoptetOrderId: 59780, comment: "Druhá poznámka" },
        ],
      });

      expect(results).toEqual([
        { orderId: "order-1", externalOrderId: "20261273", ok: true, errorDetail: null },
        { orderId: "order-2", externalOrderId: "20261272", ok: true, errorDetail: null },
      ]);
      expect(fixture.getShopRemark(59783)).toContain("Prvá poznámka");
      expect(fixture.getShopRemark(59780)).toContain("Druhá poznámka");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    // review of PR 143: predchádzajúca verzia tohto testu mala obe
    // objednávky vždy úspešné, takže NIKDY nezacvičila per-objednávkovú
    // try/catch vetvu vo `writeOneOrderNote` — `breakOrder` teraz naozaj
    // vráti stránku BEZ `textarea[name=shopRemark]` pre PRVÚ objednávku,
    // aby test dokázal, že jej zlyhanie NEPRERUŠÍ zápis druhej.
    "a GENUINE failure on one order (missing shopRemark field) does not stop the rest",
    async () => {
      fixture = await startOrderDetailFixture({ user: "manager", password: "tajneheslo" });
      fixture.breakOrder(59783);

      const results = await runOrderNoteWriteback({
        config: { loginUrl: `${fixture.baseUrl}/admin/`, adminBaseUrl: fixture.baseUrl, user: "manager", password: "tajneheslo" },
        orders: [
          { orderId: "order-1", externalOrderId: "20261273", shoptetOrderId: 59783, comment: "Prvá poznámka" },
          { orderId: "order-2", externalOrderId: "20261272", shoptetOrderId: 59780, comment: "Druhá poznámka" },
        ],
      });

      expect(results).toHaveLength(2);
      expect(results[0]?.ok).toBe(false);
      expect(results[0]?.errorDetail).toMatch(/shopRemark/);
      expect(results[1]).toEqual({ orderId: "order-2", externalOrderId: "20261272", ok: true, errorDetail: null });
      // the broken order never got a value written; the healthy one did
      expect(fixture.getShopRemark(59783)).toBeNull();
      expect(fixture.getShopRemark(59780)).toContain("Druhá poznámka");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports ok:false with an error detail when login credentials are wrong — never silently succeeds",
    async () => {
      fixture = await startOrderDetailFixture({ user: "manager", password: "tajneheslo" });

      await expect(
        runOrderNoteWriteback({
          config: { loginUrl: `${fixture.baseUrl}/admin/`, adminBaseUrl: fixture.baseUrl, user: "manager", password: "ZLE-heslo" },
          orders: [{ orderId: "order-1", externalOrderId: "20261273", shoptetOrderId: 59783, comment: "x" }],
        }),
      ).rejects.toThrow(/prihlásenie/i);
    },
    TEST_TIMEOUT_MS,
  );
});

// Issue 313: rovnaký dieťa-proces izolačný vzor ako `runShoptetImportIsolated`
// (`shoptet-writeback-playwright.integration.test.ts`) — `loginToShoptetAdmin`
// je zdieľaná, appka's vlastný bežiaci proces spúšťal Chromium PRIAMO v
// sebe pre TÚTO automatizáciu rovnako ako pre CSV import.
describe("runOrderNoteWritebackIsolated (dieťa proces, issue 313)", () => {
  let fixture: OrderDetailFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it(
    "appends our block to an EMPTY shopRemark, run in an isolated child process",
    async () => {
      fixture = await startOrderDetailFixture({ user: "manager", password: "tajneheslo" });

      const results = await runOrderNoteWritebackIsolated({
        config: { loginUrl: `${fixture.baseUrl}/admin/`, adminBaseUrl: fixture.baseUrl, user: "manager", password: "tajneheslo" },
        orders: [{ orderId: "order-1", externalOrderId: "20261273", shoptetOrderId: 59783, comment: "Zavolať zajtra" }],
      });

      expect(results).toEqual([{ orderId: "order-1", externalOrderId: "20261273", ok: true, errorDetail: null }]);
      expect(fixture.getShopRemark(59783)).toBe("--- poznámka z appky ---\nZavolať zajtra\n--- koniec ---");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "propagates a login failure back through the child process as a rejected promise",
    async () => {
      fixture = await startOrderDetailFixture({ user: "manager", password: "tajneheslo" });

      await expect(
        runOrderNoteWritebackIsolated({
          config: { loginUrl: `${fixture.baseUrl}/admin/`, adminBaseUrl: fixture.baseUrl, user: "manager", password: "ZLE-heslo" },
          orders: [{ orderId: "order-1", externalOrderId: "20261273", shoptetOrderId: 59783, comment: "x" }],
        }),
      ).rejects.toThrow(/prihlásenie/i);
    },
    TEST_TIMEOUT_MS,
  );
});
