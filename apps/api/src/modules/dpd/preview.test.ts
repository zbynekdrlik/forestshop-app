import { describe, expect, it } from "vitest";
import { buildDpdShipmentPreview, DEFAULT_PARCEL_WEIGHT_KG, type DpdOrderSource } from "./preview.js";

function order(overrides: Partial<DpdOrderSource> = {}): DpdOrderSource {
  return {
    id: "order-1",
    externalOrderId: "20300001",
    customerName: "Ján Novák",
    phone: "+421900123456",
    deliveryFullName: "Ján Novák",
    deliveryCompany: null,
    deliveryStreet: "Hlavná",
    deliveryHouseNumber: "12",
    deliveryCity: "Poprad",
    deliveryZip: "05801",
    deliveryCountryName: "Slovensko",
    weight: "1.50",
    paymentMethodName: "Dobierka (hotovosť) + karta (len SR)",
    priceToPay: "32.50",
    totalPriceWithVat: "32.50",
    ...overrides,
  };
}

describe("buildDpdShipmentPreview", () => {
  it("skladá príjemcu z uloženej doručovacej adresy", () => {
    const preview = buildDpdShipmentPreview(order());
    expect(preview).toMatchObject({
      orderId: "order-1",
      externalOrderId: "20300001",
      recipientName: "Ján Novák",
      street: "Hlavná",
      houseNumber: "12",
      city: "Poprad",
      zip: "05801",
      countryName: "Slovensko",
      addressComplete: true,
      weightKg: "1.50",
      isCod: true,
      codAmount: "32.50",
    });
  });

  it("meno príjemcu padá na customerName, keď deliveryFullName chýba", () => {
    const preview = buildDpdShipmentPreview(order({ deliveryFullName: null, customerName: "Fakturačné Meno" }));
    expect(preview.recipientName).toBe("Fakturačné Meno");
  });

  it("dopĺňa predvolenú hmotnosť, keď je uložená hmotnosť null alebo 0", () => {
    expect(buildDpdShipmentPreview(order({ weight: null })).weightKg).toBe(DEFAULT_PARCEL_WEIGHT_KG);
    expect(buildDpdShipmentPreview(order({ weight: "0" })).weightKg).toBe(DEFAULT_PARCEL_WEIGHT_KG);
    expect(buildDpdShipmentPreview(order({ weight: "0.00" })).weightKg).toBe(DEFAULT_PARCEL_WEIGHT_KG);
  });

  it("obsluhou zadaný weightKgOverride vyhráva nad uloženou aj predvolenou hodnotou", () => {
    expect(buildDpdShipmentPreview(order(), "2.75").weightKg).toBe("2.75");
    expect(buildDpdShipmentPreview(order({ weight: null }), "3.00").weightKg).toBe("3.00");
  });

  it('rozpozná dobierku podľa "dobierka" v názve platby, case-insensitive', () => {
    expect(buildDpdShipmentPreview(order({ paymentMethodName: "DOBIERKA (hotovosť)" })).isCod).toBe(true);
    expect(buildDpdShipmentPreview(order({ paymentMethodName: "Platba kartou vopred" })).isCod).toBe(false);
    expect(buildDpdShipmentPreview(order({ paymentMethodName: null })).isCod).toBe(false);
  });

  it("nedobierková objednávka nemá codAmount, aj keď priceToPay existuje", () => {
    const preview = buildDpdShipmentPreview(order({ paymentMethodName: "Platba kartou vopred", priceToPay: "10.00" }));
    expect(preview.isCod).toBe(false);
    expect(preview.codAmount).toBeNull();
  });

  it("codAmount padá na totalPriceWithVat, keď priceToPay chýba", () => {
    const preview = buildDpdShipmentPreview(order({ priceToPay: null, totalPriceWithVat: "40.00" }));
    expect(preview.codAmount).toBe("40.00");
  });

  it("addressComplete je false, keď chýba ktorékoľvek z povinných adresných polí", () => {
    expect(buildDpdShipmentPreview(order({ deliveryStreet: null })).addressComplete).toBe(false);
    expect(buildDpdShipmentPreview(order({ deliveryCity: "" })).addressComplete).toBe(false);
    expect(buildDpdShipmentPreview(order({ deliveryZip: null })).addressComplete).toBe(false);
    expect(buildDpdShipmentPreview(order({ deliveryCountryName: null })).addressComplete).toBe(false);
  });
});
