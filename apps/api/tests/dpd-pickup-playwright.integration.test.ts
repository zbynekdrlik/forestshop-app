import { afterEach, describe, expect, it } from "vitest";
import { dpdPortalConfigFromBaseUrl } from "../src/modules/dpd/config.js";
import { runOrderDpdPickup, runOrderDpdPickupIsolated } from "../src/modules/dpd/pickup-playwright.js";
import { startDpdFixture, type DpdFixture } from "./helpers/dpd-portal-fixture.js";

// Reálny Chromium proti LOKÁLNEJ fixture appke (nikdy proti skutočnému
// dpdshipper.sk — issue 292's bezpečnostné pravidlo, `.claude/rules/dpd.md`).
const TEST_TIMEOUT_MS = 120_000; // issue 460: realny Chromium (~16 s baseline) proti fixture + premenlivy CI runner — rezerva ~8x, nie band-aid (merane zo surodencov, nie odhad)
const USER = "manager";
const PASSWORD = "tajneheslo";

describe("runOrderDpdPickup (proti fixture, nikdy proti reálnemu DPD)", () => {
  let fixture: DpdFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it(
    "vyplní dátum (slovenský tvar bez vedúcich núl), prejde cez Pokračovať do review kroku a uloží cez #button-save",
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
    "zavrie prekrývajúci info banner (Štěpánov krok 2) pred vyplnením — inak by klik na formulár zlyhal",
    async () => {
      fixture = await startDpdFixture({ user: USER, password: PASSWORD, showInfoBanner: true });
      const outcome = await runOrderDpdPickup({
        config: dpdPortalConfigFromBaseUrl(fixture.baseUrl, USER, PASSWORD),
        pickupDate: "2026-08-10",
      });

      // Úspech je dôkaz, že banner bol zatvorený: kým prekrýva formulár,
      // `Pokračovať`/`Uložiť` klik zachytí banner a robot zlyhá (ok:false).
      expect(outcome.ok).toBe(true);
      expect(outcome.errorDetail).toBeNull();
      expect(fixture.lastPickupDate()).toBe("10. 8. 2026");
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

  it(
    "vráti ok:false s 'nepotvrdila', keď po Uložení review krok NEZMIZNE ani sa nezobrazí chyba (tichý/zaseknutý portál) — nikdy tiché ok:true",
    async () => {
      fixture = await startDpdFixture({ user: USER, password: PASSWORD, pickupSaveHangs: true });
      const outcome = await runOrderDpdPickup({
        config: dpdPortalConfigFromBaseUrl(fixture.baseUrl, USER, PASSWORD),
        pickupDate: "2026-08-10",
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.errorDetail).toMatch(/nepotvrdila/i);
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
