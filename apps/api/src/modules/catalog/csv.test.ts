import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeCp1250, parseDelimited, parseShoptetCsv } from "./csv.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/shoptet-sample.csv", import.meta.url)),
);

describe("decodeCp1250", () => {
  it("dekóduje slovenskú diakritiku zo stredoeurópskej stránky", () => {
    // 0xc8 0x69 0x61 0x70 = "Čiap" v cp1250 (0x8d z pôvodného zadania je "Ť", nie "Č" —
    // overené cez Python `bytes([0x8d]).decode("cp1250")` == "Ť"; "Č" je 0xc8)
    expect(decodeCp1250(Buffer.from([0xc8, 0x69, 0x61, 0x70]))).toBe("Čiap");
  });
});

describe("parseDelimited", () => {
  it("rozdelí obyčajné riadky ukončené CRLF", () => {
    expect([...parseDelimited('a;b;c\r\n1;2;3\r\n')]).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("nechá zalomenie riadku vnútri úvodzoviek súčasťou bunky", () => {
    const rows = [...parseDelimited('"a";"prvý\r\ndruhý";"c"\r\n')];
    expect(rows).toEqual([["a", "prvý\r\ndruhý", "c"]]);
  });

  it("zdvojenú úvodzovku prevedie na jednu", () => {
    expect([...parseDelimited('"on ""povedal""";"b"\r\n')]).toEqual([['on "povedal"', "b"]]);
  });

  it("zachová koncové prázdne pole a nevyrobí prázdny riadok navyše", () => {
    expect([...parseDelimited('a;b;\r\n')]).toEqual([["a", "b", ""]]);
  });

  // Dnes súbor, ktorý sa skončí vnútri zacitovanej bunky, tichým omylom vyrobí
  // vierohodne vyzerajúci skrátený riadok namiesto chyby — presne ten typ
  // poškodenia, ktorý je end-to-end neviditeľný (item 2/#malformedRowCount).
  it("vyhodí chybu, keď súbor skončí vnútri zacitovanej bunky (nedokončená úvodzovka)", () => {
    expect(() => [...parseDelimited('"a";"nedokončené')]).toThrow(/zacitovanej bunky/);
  });

  it("zacitovaná bunka môže obsahovať oddeľovač", () => {
    expect([...parseDelimited('"a;b";"c"\r\n')]).toEqual([["a;b", "c"]]);
  });

  it("zdvojená úvodzovka hneď na začiatku bunky", () => {
    expect([...parseDelimited('"""start";"other"\r\n')]).toEqual([['"start', "other"]]);
  });

  it("zdvojená úvodzovka na samom konci bunky", () => {
    expect([...parseDelimited('"end""";"other"\r\n')]).toEqual([['end"', "other"]]);
  });

  it("koniec súboru bez ukončujúceho zalomenia riadku", () => {
    expect([...parseDelimited("a;b;c")]).toEqual([["a", "b", "c"]]);
  });

  it("osamelé CR (bez LF) ukončuje riadok rovnako ako CRLF", () => {
    expect([...parseDelimited("a;b\rc;d\r")]).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseShoptetCsv nad reálnou fixtúrou", () => {
  it("prečíta všetkých 265 stĺpcov vrátane koncového prázdneho", () => {
    const csv = parseShoptetCsv(FIXTURE);
    expect(csv.columns).toHaveLength(265);
    expect(csv.columns[0]).toBe("code");
    expect(csv.columns[264]).toBe("");
    expect(csv.columns).toContain("supplier");
    expect(csv.columns).toContain("availabilityInStock");
    expect(csv.columns).toContain("variant:Veľkosť");
  });

  it("prečíta všetkých 35 riadkov", () => {
    expect([...parseShoptetCsv(FIXTURE).rows()]).toHaveLength(35);
  });

  it("prvý riadok má správne hodnoty a popis so zalomením riadku", () => {
    const [first] = [...parseShoptetCsv(FIXTURE).rows()];
    expect(first?.["code"]).toBe("40237/3XL");
    expect(first?.["pairCode"]).toBe("1");
    expect(first?.["name"]).toBe("Nohavice FOREST 1003");
    expect(first?.["price"]).toBe("62,76");
    expect(first?.["currency"]).toBe("EUR");
    expect(first?.["stock"]).toBe("-11");
    expect(first?.["availabilityInStock"]).toBe("Predaj výrobku skončil");
    expect(first?.["productVisibility"]).toBe("visible");
    expect(first?.["description"]).toContain("\r\n");
    expect(first?.["description"]?.startsWith("<p><strong><big>Použitie: ")).toBe(true);
  });

  it("nájde jednovariantný produkt s prázdnym pairCode a český text dostupnosti", () => {
    const rows = [...parseShoptetCsv(FIXTURE).rows()];
    const ciapka = rows.find((r) => r["code"] === "40287");
    expect(ciapka?.["name"]).toBe("Čiapka Polar FOREST");
    expect(ciapka?.["pairCode"]).toBe("");
    const objimka = rows.find((r) => r["code"] === "278");
    expect(objimka?.["availabilityOutOfStock"]).toBe("Není skladem");
  });

  it("nevyrobí kľúč z prázdneho názvu stĺpca", () => {
    const [first] = [...parseShoptetCsv(FIXTURE).rows()];
    expect(Object.keys(first ?? {})).not.toContain("");
  });
});
