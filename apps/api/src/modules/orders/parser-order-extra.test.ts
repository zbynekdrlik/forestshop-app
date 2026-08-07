import { describe, expect, it } from "vitest";
import { EMPTY_ORDER_LEVEL_EXTRA, extractOrderLevelExtra, mergeOrderLevelExtra } from "./parser.js";

// Vydelené z `parser.test.ts`, aby ani jeden nenarástol cez eslint's
// `max-lines: 400` (issue 292 pridalo doručovaciu adresu/hmotnosť/spôsob
// platby k existujúcim issue-172 poliam, `.claude/rules/testing.md`).

// issue 172/292: "Nevyzdvihnuté zásielky"/"DPD preprava" potrebujú
// email/telefón/číslo zásielky/doručovaciu adresu/hmotnosť/spôsob platby
// (objednávkové polia) a meno dopravcu (LEN zo SHIPPING pseudo-riadku).
describe("extractOrderLevelExtra", () => {
  it("vytiahne email/phone/packageNumber/doručovaciu adresu/hmotnosť z bežného produktového riadku", () => {
    const extra = extractOrderLevelExtra({
      code: "20300001",
      email: "jan@example.sk",
      phone: "+421900123456",
      packageNumber: "EF123456789SK",
      deliveryFullName: "Ján Novák",
      deliveryCompany: "",
      deliveryStreet: "Hlavná",
      deliveryHouseNumber: "12",
      deliveryCity: "Poprad",
      deliveryZip: "05801",
      deliveryCountryName: "Slovensko",
      weight: "1,5",
      priceToPay: "32,50",
      itemCode: "40237/XL",
      itemName: "Nohavice FOREST 1003",
    });
    expect(extra).toEqual({
      email: "jan@example.sk",
      phone: "+421900123456",
      packageNumber: "EF123456789SK",
      shippingCarrierName: null,
      deliveryFullName: "Ján Novák",
      deliveryCompany: null,
      deliveryStreet: "Hlavná",
      deliveryHouseNumber: "12",
      deliveryCity: "Poprad",
      deliveryZip: "05801",
      deliveryCountryName: "Slovensko",
      weight: "1.5",
      paymentMethodName: null,
      priceToPay: "32.50",
    });
  });

  it("vytiahne meno dopravcu LEN keď itemCode začína SHIPPING (case-insensitive)", () => {
    const extra = extractOrderLevelExtra({
      code: "20300001",
      itemCode: "shipping6",
      itemName: "Kuriér",
    });
    expect(extra.shippingCarrierName).toBe("Kuriér");
    expect(extra.paymentMethodName).toBeNull();
  });

  it("vytiahne spôsob platby LEN keď itemCode začína BILLING (case-insensitive)", () => {
    const extra = extractOrderLevelExtra({
      code: "20300001",
      itemCode: "billing10",
      itemName: "Dobierka (hotovosť) + karta (len SR)",
    });
    expect(extra.paymentMethodName).toBe("Dobierka (hotovosť) + karta (len SR)");
    expect(extra.shippingCarrierName).toBeNull();
  });

  it("nezoberie itemName ako dopravcu/platbu pri DISCOUNT pseudo-riadku", () => {
    expect(extractOrderLevelExtra({ itemCode: "DISCOUNT", itemName: "Zľava" }).shippingCarrierName).toBeNull();
    expect(extractOrderLevelExtra({ itemCode: "DISCOUNT", itemName: "Zľava" }).paymentMethodName).toBeNull();
  });

  it("prázdne/chýbajúce polia sa mapujú na null, nikdy na prázdny reťazec", () => {
    expect(extractOrderLevelExtra({})).toEqual(EMPTY_ORDER_LEVEL_EXTRA);
    expect(extractOrderLevelExtra({ email: "  ", phone: "", weight: "" })).toEqual(EMPTY_ORDER_LEVEL_EXTRA);
  });
});

describe("mergeOrderLevelExtra", () => {
  it("PRVÁ neprázdna hodnota KAŽDÉHO poľa vyhráva nezávisle od ostatných polí", () => {
    const fromProductRow = extractOrderLevelExtra({
      email: "jan@example.sk",
      itemCode: "40237/XL",
      itemName: "Nohavice",
    });
    const fromShippingRow = extractOrderLevelExtra({
      packageNumber: "EF123456789SK",
      itemCode: "SHIPPING6",
      itemName: "Kuriér",
    });
    const fromBillingRow = extractOrderLevelExtra({
      itemCode: "BILLING10",
      itemName: "Dobierka (hotovosť) + karta (len SR)",
    });
    const merged = mergeOrderLevelExtra(
      mergeOrderLevelExtra(mergeOrderLevelExtra(EMPTY_ORDER_LEVEL_EXTRA, fromProductRow), fromShippingRow),
      fromBillingRow,
    );
    expect(merged).toEqual({
      email: "jan@example.sk",
      phone: null,
      packageNumber: "EF123456789SK",
      shippingCarrierName: "Kuriér",
      deliveryFullName: null,
      deliveryCompany: null,
      deliveryStreet: null,
      deliveryHouseNumber: null,
      deliveryCity: null,
      deliveryZip: null,
      deliveryCountryName: null,
      weight: null,
      paymentMethodName: "Dobierka (hotovosť) + karta (len SR)",
      priceToPay: null,
    });
  });

  it("neskoršia hodnota NIKDY neprepíše už zistenú (prvá vyhráva, nie posledná)", () => {
    const first = extractOrderLevelExtra({ email: "prvy@example.sk" });
    const second = extractOrderLevelExtra({ email: "druhy@example.sk" });
    expect(mergeOrderLevelExtra(first, second).email).toBe("prvy@example.sk");
  });
});
