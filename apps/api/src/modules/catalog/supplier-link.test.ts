import { describe, expect, it } from "vitest";
import { extractSupplierLink, setSupplierLinkInNote } from "./supplier-link.js";

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

  // issue 72: naivné orezanie triedy znakov `)]}...` bralo AJ zátvorku, ktorá
  // je súčasťou samotnej URL (nie obalujúceho textu) — treba počítať
  // vyváženosť zátvoriek v kandidátnej URL, nie orezávať naslepo.
  it("zátvorka VYVÁŽENÁ vnútri samotnej url sa neorezáva (je súčasťou adresy)", () => {
    expect(extractSupplierLink("https://shop.example.com/a_(b)")).toEqual({
      url: "https://shop.example.com/a_(b)",
      note: "https://shop.example.com/a_(b)",
    });
  });

  it("zmiešaný koniec — vyvážená zátvorka v url + koncová bodka mimo nej", () => {
    expect(extractSupplierLink("Pozri https://shop.example.com/a_(b).")).toEqual({
      url: "https://shop.example.com/a_(b)",
      note: "Pozri https://shop.example.com/a_(b).",
    });
  });

  it("hranatá zátvorka vyvážená vnútri url sa neorezáva", () => {
    expect(extractSupplierLink("https://shop.example.com/a_[b]")).toEqual({
      url: "https://shop.example.com/a_[b]",
      note: "https://shop.example.com/a_[b]",
    });
  });

  it("hranatá zátvorka NEVYVÁŽENÁ (obaľuje celý odkaz) sa aj naďalej orezáva", () => {
    expect(extractSupplierLink("[pozri https://shop.example.com/y]")).toEqual({
      url: "https://shop.example.com/y",
      note: "[pozri https://shop.example.com/y]",
    });
  });

  it("zložená zátvorka vyvážená vnútri url sa neorezáva (tretí typ zátvorky)", () => {
    expect(extractSupplierLink("https://shop.example.com/a_{b}")).toEqual({
      url: "https://shop.example.com/a_{b}",
      note: "https://shop.example.com/a_{b}",
    });
  });

  it("otváracia zátvorka BEZ zatváracej sa neorezáva (url nekončí zátvorkou)", () => {
    expect(extractSupplierLink("https://shop.example.com/a(b")).toEqual({
      url: "https://shop.example.com/a(b",
      note: "https://shop.example.com/a(b",
    });
  });
});

// Poznámka smie niesť ľubovoľný text; odkaz na dodávateľa stojí sám na
// vlastnom riadku (okolo prázdne riadky alebo iný text).
describe("extractSupplierLink — odkaz na vlastnom riadku", () => {
  it("text pred aj za odkazom, prázdne riadky okolo → vytiahne odkaz z jeho riadku", () => {
    const note = "Objednávať cez e-mail.\n\nhttps://dodavatel.example/produkt\n\nCena bez DPH 12 €.";
    expect(extractSupplierLink(note)).toEqual({ url: "https://dodavatel.example/produkt", note });
  });

  it("iný odkaz vnútri vety PRED riadkom s odkazom → vyhrá riadok s odkazom", () => {
    const note = "Návod: https://vyrobca.example/navod.pdf\nhttps://dodavatel.example/produkt";
    expect(extractSupplierLink(note).url).toBe("https://dodavatel.example/produkt");
  });

  it("medzery okolo odkazu na riadku a CRLF konce riadkov", () => {
    const note = "Poznámka\r\n   https://dodavatel.example/produkt  \r\nĎalší text";
    expect(extractSupplierLink(note).url).toBe("https://dodavatel.example/produkt");
  });

  it("viac riadkov s odkazom → prvý", () => {
    expect(extractSupplierLink("https://a.example/1\nhttps://b.example/2").url).toBe("https://a.example/1");
  });

  it("koncová interpunkcia na riadku s odkazom sa oreže", () => {
    expect(extractSupplierLink("Text\nhttps://dodavatel.example/produkt.\nText").url).toBe(
      "https://dodavatel.example/produkt",
    );
  });

  it("žiadny riadok s odkazom → staré správanie (prvý odkaz v texte)", () => {
    expect(extractSupplierLink("Dodávateľ: Trigona - https://trigona.sk/c199\nďalší riadok").url).toBe(
      "https://trigona.sk/c199",
    );
  });
});

describe("setSupplierLinkInNote", () => {
  it("prázdna alebo null poznámka → iba odkaz", () => {
    expect(setSupplierLinkInNote(null, "https://new.example/p")).toBe("https://new.example/p");
    expect(setSupplierLinkInNote("  \n ", "https://new.example/p")).toBe("https://new.example/p");
  });

  it("holý odkaz → nahradí sa", () => {
    expect(setSupplierLinkInNote("https://old.example/p", "https://new.example/p")).toBe("https://new.example/p");
  });

  it("text okolo riadku s odkazom ostáva presne taký, aký bol", () => {
    const note = "Objednávať cez e-mail.\r\n\r\n  https://old.example/p  \r\n\r\nCena 12 €.";
    expect(setSupplierLinkInNote(note, "https://new.example/p")).toBe(
      "Objednávať cez e-mail.\r\n\r\nhttps://new.example/p\r\n\r\nCena 12 €.",
    );
  });

  it("odkaz vo vete sa nemení; nový odkaz ide na nový riadok na koniec a pri čítaní vyhrá", () => {
    const merged = setSupplierLinkInNote("Dodávateľ: X - https://old.example/p\n\n", "https://new.example/p");
    expect(merged).toBe("Dodávateľ: X - https://old.example/p\nhttps://new.example/p");
    expect(extractSupplierLink(merged).url).toBe("https://new.example/p");
  });

  it("text bez odkazu → odkaz sa pripojí na nový riadok", () => {
    expect(setSupplierLinkInNote("Soxland", "https://new.example/p")).toBe("Soxland\nhttps://new.example/p");
  });

  it("odkaz so znakmi $ sa vloží doslovne (žiadne nahradzovacie vzory)", () => {
    expect(setSupplierLinkInNote("A\nhttps://old.example/p\nB", "https://new.example/p?x=$1&y=$&")).toBe(
      "A\nhttps://new.example/p?x=$1&y=$&\nB",
    );
  });
});
