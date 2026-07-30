import { describe, expect, it } from "vitest";
import { extractSupplierLink } from "./supplier-link.js";

// Tri tvary `internalNote` z reálneho exportu (issue 67) + hranice (prázdne,
// biele znaky).
describe("extractSupplierLink", () => {
  it("holý odkaz → url aj note", () => {
    expect(extractSupplierLink("https://www.huntingshop.eu/fairfax-fz-mikina")).toEqual({
      url: "https://www.huntingshop.eu/fairfax-fz-mikina",
      note: "https://www.huntingshop.eu/fairfax-fz-mikina",
    });
  });

  it("text s popisom obsahujúci odkaz → vytiahne URL, note nesie celý pôvodný text", () => {
    expect(extractSupplierLink("Dodávateľ: Trigona - https://trigona.sk/smith-s/polovnicke/c199")).toEqual({
      url: "https://trigona.sk/smith-s/polovnicke/c199",
      note: "Dodávateľ: Trigona - https://trigona.sk/smith-s/polovnicke/c199",
    });
  });

  it("text bez odkazu → url je null, note je pôvodný text (zobrazí sa ako plain text)", () => {
    expect(extractSupplierLink("Soxland")).toEqual({ url: null, note: "Soxland" });
  });

  it("prázdny reťazec → url aj note null (odkaz nemáme, nie chyba)", () => {
    expect(extractSupplierLink("")).toEqual({ url: null, note: null });
  });

  it("null → url aj note null", () => {
    expect(extractSupplierLink(null)).toEqual({ url: null, note: null });
  });

  it("len biele znaky → traktuje sa ako prázdne", () => {
    expect(extractSupplierLink("   ")).toEqual({ url: null, note: null });
  });

  it("odkaz s vedúcimi/koncovými bielymi znakmi sa orezáva", () => {
    expect(extractSupplierLink("  https://example.com/produkt  ")).toEqual({
      url: "https://example.com/produkt",
      note: "https://example.com/produkt",
    });
  });

  it("http (nie https) sa tiež rozpozná ako odkaz", () => {
    expect(extractSupplierLink("http://example.com/x")).toEqual({
      url: "http://example.com/x",
      note: "http://example.com/x",
    });
  });

  // issue 70 (code review nálezy po PR 69): `internalNote` je ručne písaný
  // voľný text, takže URL je bežne nasledovaná koncovou interpunkciou alebo
  // uzatvorená v zátvorke — tá sa nesmie stať súčasťou `href`.
  it("odkaz nasledovaný bodkou → bodka sa neberie ako súčasť url", () => {
    expect(
      extractSupplierLink("Dodavatel odkaz: https://shop.example.com/produkt-x-2026."),
    ).toEqual({
      url: "https://shop.example.com/produkt-x-2026",
      note: "Dodavatel odkaz: https://shop.example.com/produkt-x-2026.",
    });
  });

  it("odkaz v zátvorke → uzatváracia zátvorka sa neberie ako súčasť url", () => {
    expect(extractSupplierLink("(pozri https://shop.example.com/x)")).toEqual({
      url: "https://shop.example.com/x",
      note: "(pozri https://shop.example.com/x)",
    });
  });

  it("poznámka s viacerými odkazmi → zoberie prvý výskyt (zámerné, first-match)", () => {
    expect(
      extractSupplierLink("Primárny https://a.example.com/prvy, záložný https://b.example.com/druhy"),
    ).toEqual({
      url: "https://a.example.com/prvy",
      note: "Primárny https://a.example.com/prvy, záložný https://b.example.com/druhy",
    });
  });
});
