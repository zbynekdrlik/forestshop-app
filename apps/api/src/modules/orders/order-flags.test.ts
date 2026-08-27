import { describe, expect, it } from "vitest";
import { isExchangeOrderStatus, isReturnedOrderStatus } from "./order-flags.js";

// issue 514 (invertuje issue 290): sekcia „Výmena tovaru" má ukazovať
// AKTÍVNE výmeny — presne stav "Výmena tovaru", nie hotový "Vybavená výmena"
// (ten sa z výpisu odstraňuje). Issue 290 pôvodne priradilo "Vybavená
// výmena", lebo vtedy (7.8.2026) produkcia nemala ani jednu objednávku v
// stave "Výmena tovaru" — realita sa medzitým zmenila (živo overené na
// tikete: 1× "Výmena tovaru", 8× "Vybavená výmena"). Issue 516 rovnako zúžilo
// "Vrátený tovar" na PRESNE aktívny stav "Vratený tovar" — hotový "Vybavený
// Dobropis" sa už nezobrazuje (živo overené: 3× "Vratený tovar", 5× "Vybavený
// Dobropis"). Rovnaká normalizačná disciplína ako `return-status.test.ts`
// (NFC + orez, nikdy bajtovo presná zhoda).
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
  it("rozpozná AKTÍVny stav 'Vratený tovar' (issue 516)", () => {
    expect(isReturnedOrderStatus("Vratený tovar")).toBe(true);
  });

  // issue 516: sekcia „Vrátený tovar" má ukazovať LEN aktívne „Vratený tovar",
  // nie hotový „Vybavený Dobropis" (zrkadlo #514 pre výmenu). Issue 290 pôvodne
  // priradilo OBA stavy; #516 to zúžilo. „Vybavený Dobropis" ostáva HOTOVÝM
  // vrátkovým stavom výhradne v `return-status.ts` (auto-zatvára kartu).
  it("'Vybavený Dobropis' UŽ NIE JE priradený — issue 516 ho z výpisu aj počtu odstránilo", () => {
    expect(isReturnedOrderStatus("Vybavený Dobropis")).toBe(false);
  });

  it("výmenový/bežné stavy nie sú vrátený tovar", () => {
    expect(isReturnedOrderStatus("Vybavená výmena")).toBe(false);
    expect(isReturnedOrderStatus("Vybavená")).toBe(false);
    expect(isReturnedOrderStatus("Stornovaná")).toBe(false);
    expect(isReturnedOrderStatus("")).toBe(false);
  });

  it("normalizuje (NFC + orez) rovnako ako order.status_name", () => {
    expect(isReturnedOrderStatus("  Vratený tovar  ")).toBe(true);
    expect(isReturnedOrderStatus("Vratený tovar".normalize("NFD"))).toBe(true);
  });
});
