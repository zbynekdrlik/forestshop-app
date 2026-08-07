import { describe, expect, it } from "vitest";
import { isExchangeOrderStatus, isReturnedOrderStatus } from "./order-flags.js";

// issue 290: priradenie OVERENÉ NAŽIVO na produkcii (tiket) — "Výmena
// tovaru" = presne "Vybavená výmena", "Vrátený tovar" = "Vratený tovar" +
// "Vybavený Dobropis". Rovnaká normalizačná disciplína ako `return-
// status.test.ts` (NFC + orez, nikdy bajtovo presná zhoda).
describe("isExchangeOrderStatus", () => {
  it("rozpozná jediný priradený stav 'Vybavená výmena'", () => {
    expect(isExchangeOrderStatus("Vybavená výmena")).toBe(true);
  });

  it("'Výmena tovaru' (rozpracovaný stav) NIE JE priradený — dnes nemá žiadnu objednávku", () => {
    expect(isExchangeOrderStatus("Výmena tovaru")).toBe(false);
  });

  it("vrátkové/bežné stavy nie sú výmena", () => {
    expect(isExchangeOrderStatus("Vratený tovar")).toBe(false);
    expect(isExchangeOrderStatus("Vybavený Dobropis")).toBe(false);
    expect(isExchangeOrderStatus("Vybavená")).toBe(false);
    expect(isExchangeOrderStatus("")).toBe(false);
  });

  it("normalizuje (NFC + orez) rovnako ako order.status_name", () => {
    expect(isExchangeOrderStatus("  Vybavená výmena  ")).toBe(true);
    expect(isExchangeOrderStatus("Vybavená výmena".normalize("NFD"))).toBe(true);
  });
});

describe("isReturnedOrderStatus", () => {
  it("rozpozná OBA priradené stavy — 'Vratený tovar' aj jeho hotovú podobu 'Vybavený Dobropis'", () => {
    expect(isReturnedOrderStatus("Vratený tovar")).toBe(true);
    expect(isReturnedOrderStatus("Vybavený Dobropis")).toBe(true);
  });

  it("výmenový/bežné stavy nie sú vrátený tovar", () => {
    expect(isReturnedOrderStatus("Vybavená výmena")).toBe(false);
    expect(isReturnedOrderStatus("Vybavená")).toBe(false);
    expect(isReturnedOrderStatus("Stornovaná")).toBe(false);
    expect(isReturnedOrderStatus("")).toBe(false);
  });

  it("normalizuje (NFC + orez) rovnako ako order.status_name", () => {
    expect(isReturnedOrderStatus("  Vratený tovar  ")).toBe(true);
    expect(isReturnedOrderStatus("Vybavený Dobropis".normalize("NFD"))).toBe(true);
  });
});
