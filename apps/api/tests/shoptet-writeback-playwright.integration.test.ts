import { afterEach, describe, expect, it } from "vitest";
import { buildWritebackCsv } from "../src/modules/shoptet-writeback/csv.js";
import { runShoptetImport } from "../src/modules/shoptet-writeback/playwright-import.js";
import { startShoptetFixture, type ShoptetFixture } from "./helpers/shoptet-fixture.js";

// Reálny Chromium proti LOKÁLNEJ fixture appke (nikdy proti skutočnému
// Shoptetu — issue 122's testová požiadavka). Browser beh môže byť pomalší
// v CI, preto vyšší timeout než ostatné integračné testy.
const TEST_TIMEOUT_MS = 60_000;

describe("runShoptetImport (proti fixture, nikdy proti reálnemu Shoptetu)", () => {
  let fixture: ShoptetFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it(
    "prihlási sa, nahrá CSV, over bezpečné nastavenia a potvrdí úspech z Logu",
    async () => {
      fixture = await startShoptetFixture({ user: "manager", password: "tajneheslo" });
      fixture.seedPastEntry();
      const csv = buildWritebackCsv([
        { code: "A/S", pairCode: "1", internalNote: "https://dodavatel.example/a" },
        { code: "A/M", pairCode: "2", internalNote: "https://dodavatel.example/a" },
      ]);

      const outcome = await runShoptetImport({
        config: {
          loginUrl: `${fixture.baseUrl}/admin/`,
          importUrl: `${fixture.baseUrl}/admin/import-produktov/`,
          logUrl: `${fixture.baseUrl}/admin/import-produktov/log/`,
          user: "manager",
          password: "tajneheslo",
        },
        csv,
        expectedRows: 2,
        resultPollRetries: 3,
        resultPollWaitMs: 100,
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.processed).toBe(2);
      expect(outcome.failed).toBe(0);
      expect(outcome.errorDetail).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "throws when the credentials are wrong — never silently 'succeeds'",
    async () => {
      fixture = await startShoptetFixture({ user: "manager", password: "tajneheslo" });
      fixture.seedPastEntry();
      const csv = buildWritebackCsv([{ code: "A", pairCode: "", internalNote: "https://x.example/a" }]);

      await expect(
        runShoptetImport({
          config: {
            loginUrl: `${fixture.baseUrl}/admin/`,
            importUrl: `${fixture.baseUrl}/admin/import-produktov/`,
            logUrl: `${fixture.baseUrl}/admin/import-produktov/log/`,
            user: "manager",
            password: "ZLE-heslo",
          },
          csv,
          expectedRows: 1,
        }),
      ).rejects.toThrow(/prihlásenie/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses to upload when the safe-mode radio is missing from the import form (fail-closed)",
    async () => {
      fixture = await startShoptetFixture({ user: "manager", password: "tajneheslo", omitSafeRadio: true });
      fixture.seedPastEntry();
      const csv = buildWritebackCsv([{ code: "A", pairCode: "", internalNote: "https://x.example/a" }]);

      await expect(
        runShoptetImport({
          config: {
            loginUrl: `${fixture.baseUrl}/admin/`,
            importUrl: `${fixture.baseUrl}/admin/import-produktov/`,
            logUrl: `${fixture.baseUrl}/admin/import-produktov/log/`,
            user: "manager",
            password: "tajneheslo",
          },
          csv,
          expectedRows: 1,
        }),
      ).rejects.toThrow(/bezpečn/i);
      // and NOTHING new was uploaded — only the pre-existing seeded entry remains
      expect(fixture.logEntryCount()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports a hard Shoptet abort (no Spracované summary) as ok:false with the error detail surfaced",
    async () => {
      fixture = await startShoptetFixture({ user: "manager", password: "tajneheslo" });
      fixture.seedPastEntry();
      fixture.setOutcome("hard-error");
      const csv = buildWritebackCsv([{ code: "A", pairCode: "", internalNote: "https://x.example/a" }]);

      const outcome = await runShoptetImport({
        config: {
          loginUrl: `${fixture.baseUrl}/admin/`,
          importUrl: `${fixture.baseUrl}/admin/import-produktov/`,
          logUrl: `${fixture.baseUrl}/admin/import-produktov/log/`,
          user: "manager",
          password: "tajneheslo",
        },
        csv,
        expectedRows: 1,
        resultPollRetries: 3,
        resultPollWaitMs: 100,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.processed).toBeNull();
      expect(outcome.errorDetail).toContain("Data in column code are not unique");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports a partial failure (some rows rejected) as ok:false",
    async () => {
      fixture = await startShoptetFixture({ user: "manager", password: "tajneheslo" });
      fixture.seedPastEntry();
      fixture.setOutcome("partial");
      const csv = buildWritebackCsv([
        { code: "A", pairCode: "", internalNote: "https://x.example/a" },
        { code: "B", pairCode: "", internalNote: "https://x.example/b" },
      ]);

      const outcome = await runShoptetImport({
        config: {
          loginUrl: `${fixture.baseUrl}/admin/`,
          importUrl: `${fixture.baseUrl}/admin/import-produktov/`,
          logUrl: `${fixture.baseUrl}/admin/import-produktov/log/`,
          user: "manager",
          password: "tajneheslo",
        },
        csv,
        expectedRows: 2,
        resultPollRetries: 3,
        resultPollWaitMs: 100,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.processed).toBe(2);
      expect(outcome.failed).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
