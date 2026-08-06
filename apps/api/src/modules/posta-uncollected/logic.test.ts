import { describe, expect, it, vi } from "vitest";
import { MAIL_TEMPLATE_KINDS } from "../mail-templates/registry.js";

// issue 293 review finding: `buildEmail`'s `retainedTillDisplay` je jediné
// miesto v tomto module, čo si dátum na Y/M/D rozoberá SAMO (`getUTCDate()`
// atď.) namiesto zdieľaného `timezone.ts`'s `getZonedDateParts` — tento spy
// dokazuje, že po oprave naň skutočne ide. Priamy `vi.spyOn` na natívny ESM
// modul zlyhá ("Module namespace is not configurable in ESM") — `vi.mock` s
// `importOriginal` je jediný spôsob, ako v ESM prostredí nahradiť JEDEN
// export a ostatné (`zonedDateKey`) nechať skutočné (rovnaký vzor ako
// `modules/orders/raw-prune.test.ts`).
const { getZonedDateParts: spiedGetZonedDateParts } = vi.hoisted(() => ({ getZonedDateParts: vi.fn() }));
vi.mock("../../timezone.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../timezone.js")>();
  spiedGetZonedDateParts.mockImplementation(actual.getZonedDateParts);
  return { ...actual, getZonedDateParts: spiedGetZonedDateParts };
});

import {
  buildEmail,
  postaTemplateKey,
  classifyTracking,
  isEligibleOrder,
  isNonPostaCarrier,
  shouldSend,
  sourceCoverage,
  terminalState,
  type EligibleOrder,
} from "./logic.js";

const TODAY = new Date("2026-08-02T00:00:00Z");

function order(overrides: Partial<EligibleOrder> = {}): EligibleOrder {
  return {
    externalOrderId: "20300001",
    placedAt: new Date("2026-07-20T00:00:00Z"),
    statusName: "Vybavená",
    shippingCarrierName: "Kuriér",
    packageNumber: "EF123456789SK",
    email: "jan@example.sk",
    phone: "+421900000000",
    customerName: "Ján Novák",
    shoptetOrderId: null,
    ...overrides,
  };
}

describe("isNonPostaCarrier", () => {
  it("rozpozná DPD a osobný odber, nikdy Kuriér (Pošta SK domáce doručenie)", () => {
    expect(isNonPostaCarrier("DPD doručenie na adresu")).toBe(true);
    expect(isNonPostaCarrier("Osobný odber - len na predajni")).toBe(true);
    expect(isNonPostaCarrier("Kuriér")).toBe(false);
    expect(isNonPostaCarrier(null)).toBe(false);
  });

  it("case-insensitive zhoda", () => {
    expect(isNonPostaCarrier("dpd doručenie")).toBe(true);
  });
});

describe("isEligibleOrder", () => {
  it("vylúči stornovanú objednávku", () => {
    expect(isEligibleOrder(order({ statusName: "Stornovaná" }), TODAY)).toBe(false);
  });

  it("vylúči iného dopravcu než poštu", () => {
    expect(isEligibleOrder(order({ shippingCarrierName: "DPD kuriér" }), TODAY)).toBe(false);
  });

  it("vylúči objednávku staršiu než 30 dní", () => {
    expect(isEligibleOrder(order({ placedAt: new Date("2026-06-01T00:00:00Z") }), TODAY)).toBe(false);
  });

  it("ponechá objednávku bez SHIPPING riadku (neznámy dopravca — fail-open)", () => {
    expect(isEligibleOrder(order({ shippingCarrierName: null }), TODAY)).toBe(true);
  });

  it("ponechá bežnú objednávku v okne", () => {
    expect(isEligibleOrder(order(), TODAY)).toBe(true);
  });
});

describe("sourceCoverage", () => {
  it("degraded=false pod hranicou MIN_DISPATCHED_FOR_ALARM (málo dôkazov)", () => {
    const eligible = [order({ externalOrderId: "1", packageNumber: null })];
    const cov = sourceCoverage(eligible, TODAY);
    expect(cov.degraded).toBe(false);
  });

  it("degraded=true keď málo dispatched objednávok má číslo zásielky (coverage < 50%)", () => {
    const eligible = Array.from({ length: 6 }, (_, i) =>
      order({ externalOrderId: `d${String(i)}`, packageNumber: i < 1 ? "EF1SK" : null }),
    );
    const cov = sourceCoverage(eligible, TODAY);
    expect(cov.dispatchedOrders).toBe(6);
    expect(cov.dispatchedWithPackage).toBe(1);
    expect(cov.degraded).toBe(true);
  });

  it("degraded=false keď coverage je zdravá", () => {
    const eligible = Array.from({ length: 6 }, (_, i) => order({ externalOrderId: `h${String(i)}`, packageNumber: "EF1SK" }));
    expect(sourceCoverage(eligible, TODAY).degraded).toBe(false);
  });

  it("dispatchedStatusUnknown keď dosť eligible objednávok, ale takmer žiadna nie je rozpoznaná ako dispatched", () => {
    const eligible = Array.from({ length: 20 }, (_, i) => order({ externalOrderId: `u${String(i)}`, statusName: "Vybavuje sa" }));
    const cov = sourceCoverage(eligible, TODAY);
    expect(cov.dispatchedOrders).toBe(0);
    expect(cov.dispatchedStatusUnknown).toBe(true);
  });
});

describe("classifyTracking", () => {
  it("uncollected=true pre notified + ZNP kód", () => {
    const cls = classifyTracking(
      {
        results: [
          {
            status: "ok",
            retainedTill: "2026-08-10",
            events: [{ stateCode: "notified", detailCode: "ZNP1AN", localDate: "2026-07-30", postOffice: { name: "Pošta 1", street: "Hlavná 1", postcode: "01001", city: "Žilina" } }],
          },
        ],
      },
      TODAY,
    );
    expect(cls.uncollected).toBe(true);
    expect(cls.officeName).toBe("Pošta 1");
    expect(cls.officeAddr).toBe("Hlavná 1, 01001 Žilina");
    expect(cls.retainedTill).toBe("2026-08-10");
    expect(cls.daysAtPost).toBe(3);
  });

  it("invalid_format status prejde bez udalostí", () => {
    const cls = classifyTracking({ results: [{ status: "invalid_format" }] }, TODAY);
    expect(cls.status).toBe("invalid_format");
    expect(cls.uncollected).toBe(false);
  });

  it("žiadne výsledky → no_results", () => {
    expect(classifyTracking({ results: [] }, TODAY).status).toBe("no_results");
    expect(classifyTracking(null, TODAY).status).toBe("no_results");
  });

  it("ok status bez udalostí → no_events", () => {
    expect(classifyTracking({ results: [{ status: "ok", events: [] }] }, TODAY).status).toBe("no_events");
  });

  it("posledná udalosť iná než notified/ZNP → uncollected=false", () => {
    const cls = classifyTracking({ results: [{ status: "ok", events: [{ stateCode: "transit", detailCode: "X" }] }] }, TODAY);
    expect(cls.uncollected).toBe(false);
  });
});

describe("terminalState", () => {
  it("'delivered' je terminálny", () => {
    expect(terminalState({ results: [{ status: "ok", events: [{ stateCode: "delivered" }] }] })).toBe("delivered");
  });

  it("'notified' NIE JE terminálny (to je stav, ktorý sledujeme)", () => {
    expect(terminalState({ results: [{ status: "ok", events: [{ stateCode: "notified" }] }] })).toBe("");
  });

  it("nerozpoznaný kód (napr. hypotetické 'returned') sa NEDÔVERUJE — nikdy terminálny", () => {
    expect(terminalState({ results: [{ status: "ok", events: [{ stateCode: "returned" }] }] })).toBe("");
  });

  it("invalid_format nemá terminálny stav", () => {
    expect(terminalState({ results: [{ status: "invalid_format" }] })).toBe("");
  });
});

describe("shouldSend — kadencia 0 → +3 → +3 → +7", () => {
  it("prvý e-mail (count=0) sa pošle vždy", () => {
    expect(shouldSend(0, null, TODAY)).toBe(true);
  });

  it("2. e-mail čaká presne 3 dni od 1.", () => {
    const lastSent = new Date("2026-07-30T00:00:00Z");
    expect(shouldSend(1, lastSent, new Date("2026-08-01T00:00:00Z"))).toBe(false);
    expect(shouldSend(1, lastSent, new Date("2026-08-02T00:00:00Z"))).toBe(true);
  });

  it("4. e-mail čaká 7 dní od 3.", () => {
    const lastSent = new Date("2026-07-26T00:00:00Z");
    expect(shouldSend(3, lastSent, new Date("2026-08-01T00:00:00Z"))).toBe(false);
    expect(shouldSend(3, lastSent, new Date("2026-08-02T00:00:00Z"))).toBe(true);
  });

  it("po 4. e-maile sa už nikdy nepošle ďalší (MAX_EMAILS)", () => {
    expect(shouldSend(4, new Date("2020-01-01T00:00:00Z"), TODAY)).toBe(false);
  });
});

describe("buildEmail", () => {
  it("prvý e-mail — predmet a HTML podľa starej appky doslovne", () => {
    const built = buildEmail(MAIL_TEMPLATE_KINDS[postaTemplateKey(1)].defaultText, "Ján Novák", "EF123456789SK", "Pošta 1", "Hlavná 1, Žilina", "2026-08-10", TODAY);
    expect(built.subject).toBe("Vaša zásielka čaká na vyzdvihnutie | EF123456789SK");
    expect(built.html).toContain("Ján Novák");
    expect(built.html).toContain("10. 8. 2026"); // 2026-08-10 vs today 2026-08-02 → future, teda zobrazí sa
    expect(built.html).not.toContain("<script>");
  });

  it("retainedTillDisplay ide cez zdieľaný getZonedDateParts (timezone.ts), nie cez vlastné getUTC* volania — a vykreslený deň ostáva rovnaký", () => {
    spiedGetZonedDateParts.mockClear();
    const built = buildEmail(MAIL_TEMPLATE_KINDS[postaTemplateKey(1)].defaultText, "Ján Novák", "EF123456789SK", "Pošta 1", "Hlavná 1, Žilina", "2026-08-10", TODAY);
    expect(spiedGetZonedDateParts).toHaveBeenCalled();
    expect(built.html).toContain("10. 8. 2026");
  });

  it("4. e-mail žiada priamy kontakt na eshop@forestshop.sk", () => {
    const built = buildEmail(MAIL_TEMPLATE_KINDS[postaTemplateKey(4)].defaultText, "Ján Novák", "EF1SK", "Pošta 1", "", "", TODAY);
    expect(built.subject).toBe("Posledná výzva: zásielka bude vrátená | EF1SK");
    expect(built.html).toContain("eshop@forestshop.sk");
  });

  it("dátum vyzdvihnutia, ktorý už PREŠIEL, sa nezobrazí (dateless 'čo najskôr')", () => {
    const built = buildEmail(MAIL_TEMPLATE_KINDS[postaTemplateKey(1)].defaultText, "Ján", "EF1SK", "Pošta 1", "", "2026-01-01", TODAY);
    expect(built.html).toContain("čo najskôr");
    expect(built.html).not.toContain("2026-01-01");
  });

  it("HTML escapuje meno zákazníka (žiadny injected tag)", () => {
    const built = buildEmail(MAIL_TEMPLATE_KINDS[postaTemplateKey(1)].defaultText, "<script>alert(1)</script>", "EF1SK", "Pošta 1", "", "", TODAY);
    expect(built.html).not.toContain("<script>alert(1)</script>");
    expect(built.html).toContain("&lt;script&gt;");
  });
});
