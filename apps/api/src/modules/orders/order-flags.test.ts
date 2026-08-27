import { describe, expect, it } from "vitest";
import { isExchangeOrderStatus, isReturnedOrderStatus } from "./order-flags.js";

// issue 514 (invertuje issue 290): sekcia „Výmena tovaru" má ukazovať
// AKTÍVNE výmeny — presne stav "Výmena tovaru", nie hotový "Vybavená výmena"
// (ten sa z výpisu odstraňuje). Issue 290 pôvodne priradilo "Vybavená
// výmena", lebo vtedy (7.8.2026) produkcia nemala ani jednu objednávku v
// stave "Výmena tovaru" — realita sa medzitým zmenila (živo overené na
// tikete: 1× "Výmena tovaru", 8× "Vybavená výmena"). "Vrátený tovar" =
// "Vratený tovar" + "Vybavený Dobropis" (nezmenené). Rovnaká normalizačná
// disciplína ako `return-status.test.ts` (NFC + orez, nikdy bajtovo presná
// zhoda).
describe("isExchangeOrderStatus", () => {
  it("rozpozná AKTÍVny stav 'Výmena tovaru' (issue 514)", () => {
    expect(isExchangeOrderStatus("Výmena tovaru")).toBe(true);
  });

  it("'Vybavená výmena' (vybavená výmena) UŽ NIE JE priradený — issue 514 ho z výpisu odstránilo", () => {
    expect(isExchangeOrderStatus("Vybavená výmena")).toBe(false);
  });

  it("vrátkové/bežné stavy nie sú výmena", () => {
    expect(isExchangeOrderStatus("Vratený tovar")).toBe(false);
    expect(isExchangeOrderStatus("Vybavený Dobropis")).toBe(false);
    expect(isExchangeOrderStatus("Vybavená")).toBe(false);
    expect(isExchangeOrderStatus("")).toBe(false);
  });

  it("normalizuje (NFC + orez) rovnako ako order.status_name", () => {
    expect(isExchangeOrderStatus("  Výmena tovaru  ")).toBe(true);
    expect(isExchangeOrderStatus("Výmena tovaru".normalize("NFD"))).toBe(true);
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
