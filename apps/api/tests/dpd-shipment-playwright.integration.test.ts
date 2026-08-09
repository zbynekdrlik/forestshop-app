import { afterEach, describe, expect, it } from "vitest";
import { dpdPortalConfigFromBaseUrl } from "../src/modules/dpd/config.js";
import { runCreateDpdShipment, runCreateDpdShipmentIsolated } from "../src/modules/dpd/shipment-playwright.js";
import type { DpdShipmentPreview } from "../src/modules/dpd/preview.js";
import { startDpdFixture, type DpdFixture } from "./helpers/dpd-portal-fixture.js";

// Reálny Chromium proti LOKÁLNEJ fixture appke (nikdy proti skutočnému
// dpdshipper.sk — issue 292's bezpečnostné pravidlo, `.claude/rules/dpd.md`).
const TEST_TIMEOUT_MS = 60_000;
const USER = "manager";
const PASSWORD = "tajneheslo";

function preview(overrides: Partial<DpdShipmentPreview> = {}): DpdShipmentPreview {
  return {
    orderId: "11111111-1111-1111-1111-111111111111",
    externalOrderId: "20261234",
    recipientName: "Ján Testovací",
    recipientCompany: null,
    recipientPhone: "+421903123456",
    street: "Hlavná",
    houseNumber: "15",
    city: "Košice",
    zip: "04001",
    countryName: "Slovensko",
    addressComplete: true,
    weightKg: "1.50",
    isCod: false,
    codAmount: null,
    ...overrides,
  };
}

describe("runCreateDpdShipment (proti fixture, nikdy proti reálnemu DPD)", () => {
  let fixture: DpdFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it(
    "vyplní príjemcu, hmotnosť aj predvolené rozmery presne podľa náhľadu a prečíta číslo zásielky z notifikácie",
    async () => {
      fixture = await startDpdFixture({ user: USER, password: PASSWORD });
      const outcome = await runCreateDpdShipment({
        config: dpdPortalConfigFromBaseUrl(fixture.baseUrl, USER, PASSWORD),
        shipment: preview(),
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.parcelNumber).toBe("99900000123");
      const sent = fixture.lastShipmentSubmission();
      expect(sent).not.toBeNull();
      expect(sent).toMatchObject({
        reference: "20261234",
        name: "Ján Testovací",
        street: "Hlavná",
        houseNr: "15",
        zip: "04001",
        city: "Košice",
        phone: "903123456",
        weight: "1.50",
        width: "30",
        height: "20",
        length: "20",
        codChecked: false,
        codAmount: null,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "zaškrtne Dobierku a vyplní jej sumu, keď je náhľad COD",
    async () => {
      fixture = await startDpdFixture({ user: USER, password: PASSWORD });
      const outcome = await runCreateDpdShipment({
        config: dpdPortalConfigFromBaseUrl(fixture.baseUrl, USER, PASSWORD),
        shipment: preview({ isCod: true, codAmount: "42.90" }),
      });

      expect(outcome.ok).toBe(true);
      const sent = fixture.lastShipmentSubmission();
      expect(sent?.codChecked).toBe(true);
      expect(sent?.codAmount).toBe("42.90");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "zlyhá NAHLAS (nikdy tiché ok:true), keď portál nikdy nepovolí typ produktu/COD",
    async () => {
      fixture = await startDpdFixture({ user: USER, password: PASSWORD, stuckDisabled: true });
      const outcome = await runCreateDpdShipment({
        config: dpdPortalConfigFromBaseUrl(fixture.baseUrl, USER, PASSWORD),
        shipment: preview(),
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.parcelNumber).toBeNull();
      expect(outcome.errorDetail).toMatch(/neaktívne/);
      expect(fixture.lastShipmentSubmission()).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "zlyhá NAHLAS na nie-slovenskej doručovacej krajine namiesto tichého odoslania s nesprávnou krajinou",
    async () => {
      fixture = await startDpdFixture({ user: USER, password: PASSWORD });
      const outcome = await runCreateDpdShipment({
        config: dpdPortalConfigFromBaseUrl(fixture.baseUrl, USER, PASSWORD),
        shipment: preview({ countryName: "Česká Republika" }),
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.errorDetail).toMatch(/slovensk/i);
      expect(fixture.lastShipmentSubmission()).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});

describe("runCreateDpdShipmentIsolated (dieťa proces, issue 313's vzor)", () => {
  let fixture: DpdFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it(
    "rovnaký výsledok ako in-process runCreateDpdShipment, len spustený v dieťa procese",
    async () => {
      fixture = await startDpdFixture({ user: USER, password: PASSWORD });
      const outcome = await runCreateDpdShipmentIsolated({
        config: dpdPortalConfigFromBaseUrl(fixture.baseUrl, USER, PASSWORD),
        shipment: preview(),
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.parcelNumber).toBe("99900000123");
    },
    TEST_TIMEOUT_MS,
  );
});
