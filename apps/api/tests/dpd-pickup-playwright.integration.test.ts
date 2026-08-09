import { afterEach, describe, expect, it } from "vitest";
import { dpdPortalConfigFromBaseUrl } from "../src/modules/dpd/config.js";
import { runOrderDpdPickup, runOrderDpdPickupIsolated } from "../src/modules/dpd/pickup-playwright.js";
import { startDpdFixture, type DpdFixture } from "./helpers/dpd-portal-fixture.js";

// Reálny Chromium proti LOKÁLNEJ fixture appke (nikdy proti skutočnému
// dpdshipper.sk — issue 292's bezpečnostné pravidlo, `.claude/rules/dpd.md`).
const TEST_TIMEOUT_MS = 60_000;
const USER = "manager";
const PASSWORD = "tajneheslo";

describe("runOrderDpdPickup (proti fixture, nikdy proti reálnemu DPD)", () => {
  let fixture: DpdFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it(
    "prejde oboma krokmi wizardu, nastaví dátum v slovenskom tvare bez vedúcich núl a uloží",
    async () => {
      fixture = await startDpdFixture({ user: USER, password: PASSWORD });
      const outcome = await runOrderDpdPickup({
        config: dpdPortalConfigFromBaseUrl(fixture.baseUrl, USER, PASSWORD),
        pickupDate: "2026-08-10",
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.errorDetail).toBeNull();
      expect(fixture.lastPickupDate()).toBe("10. 8. 2026");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "nezaokrúhľuje mesiac/deň s vedúcou nulou (over aj jednomiestny mesiac)",
    async () => {
      fixture = await startDpdFixture({ user: USER, password: PASSWORD });
      await runOrderDpdPickup({
        config: dpdPortalConfigFromBaseUrl(fixture.baseUrl, USER, PASSWORD),
        pickupDate: "2026-01-05",
      });

      expect(fixture.lastPickupDate()).toBe("5. 1. 2026");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "vráti ok:false s chybovou správou z portálu, keď zvoz odmietne — nikdy tiché ok:true",
    async () => {
      fixture = await startDpdFixture({ user: USER, password: PASSWORD, pickupSaveFails: true });
      const outcome = await runOrderDpdPickup({
        config: dpdPortalConfigFromBaseUrl(fixture.baseUrl, USER, PASSWORD),
        pickupDate: "2026-08-10",
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.errorDetail).toMatch(/nepodarilo/i);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("runOrderDpdPickupIsolated (dieťa proces, issue 313's vzor)", () => {
  let fixture: DpdFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it(
    "rovnaký výsledok ako in-process runOrderDpdPickup, len spustený v dieťa procese",
    async () => {
      fixture = await startDpdFixture({ user: USER, password: PASSWORD });
      const outcome = await runOrderDpdPickupIsolated({
        config: dpdPortalConfigFromBaseUrl(fixture.baseUrl, USER, PASSWORD),
        pickupDate: "2026-08-10",
      });

      expect(outcome.ok).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
