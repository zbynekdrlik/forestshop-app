import { describe, expect, it } from "vitest";
import { buildRestockCsv, buildStatesCsv, buildWritebackCsv, dedupeStateRowsByCode } from "./csv.js";

describe("buildWritebackCsv", () => {
  it("has the canonical Shoptet import header + BOM + CRLF + ';' delimiter", () => {
    const csv = buildWritebackCsv([{ code: "123/S", pairCode: "456", internalNote: "https://dodavatel.example/x" }]);
    const text = csv.toString("utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff); // BOM
    const withoutBom = text.slice(1);
    const lines = withoutBom.split("\r\n");
    expect(lines[0]).toBe("code;pairCode;internalNote");
    expect(lines[1]).toBe("123/S;456;https://dodavatel.example/x");
    // trailing CRLF leaves one empty element at the end
    expect(lines.at(-1)).toBe("");
  });

  it("emits ONE row per given variant — caller decides which variants (one per product's variants)", () => {
    const csv = buildWritebackCsv([
      { code: "A/S", pairCode: "1", internalNote: "https://x.example/a" },
      { code: "A/M", pairCode: "2", internalNote: "https://x.example/a" },
      { code: "B/S", pairCode: "", internalNote: "https://x.example/b" },
    ]);
    const rows = csv.toString("utf8").slice(1).split("\r\n").filter(Boolean);
    expect(rows).toEqual([
      "code;pairCode;internalNote",
      "A/S;1;https://x.example/a",
      "A/M;2;https://x.example/a",
      "B/S;;https://x.example/b",
    ]);
  });

  it("throws on an empty row list — never upload a file that changes nothing", () => {
    expect(() => buildWritebackCsv([])).toThrow(/žiadne riadky/i);
  });

  it("quotes a value that itself contains the delimiter or a double quote", () => {
    const csv = buildWritebackCsv([{ code: "A", pairCode: "", internalNote: 'note; with "quotes"' }]);
    const rows = csv.toString("utf8").slice(1).split("\r\n").filter(Boolean);
    expect(rows[1]).toBe('A;;"note; with ""quotes"""');
  });

  // issue 153: CSV-injection ochrana — KAŽDÁ bunka (nielen `internalNote`,
  // ktoré prechádza cez URL-tvarovú validáciu, ale aj `code`/`pairCode`,
  // ktoré prichádzajú z katalógového importu bez akejkoľvek inej kontroly)
  // začínajúca znakom vzorca sa neutralizuje priamo pri zápise CSV
  // (`formula-guard.ts`'s `csvSafe`, rovnaký mechanizmus ako referenčná
  // appka's `_csv_safe`).
  it("neutralizuje bunku začínajúcu znakom vzorca v KTOROMKOĽVEK stĺpci (CSV-injection ochrana)", () => {
    const csv = buildWritebackCsv([{ code: "=SUM(A1:A9)", pairCode: "+1", internalNote: "-2+3" }]);
    const rows = csv.toString("utf8").slice(1).split("\r\n").filter(Boolean);
    expect(rows[1]).toBe("'=SUM(A1:A9);'+1;'-2+3");
  });

  it("neutralizácia vzorca funguje aj SÚČASNE s uvodzovaním kvôli oddeľovaču", () => {
    const csv = buildWritebackCsv([{ code: "A", pairCode: "", internalNote: "=cmd|'/c calc'!A1;X" }]);
    const rows = csv.toString("utf8").slice(1).split("\r\n").filter(Boolean);
    expect(rows[1]).toBe(`A;;"'=cmd|'/c calc'!A1;X"`);
  });
});

// issue 219: majiteľ v Shoptete nepoužíva skladovú logistiku, takže zápis
// fiktívnej zásoby by mu do obchodu vpísal číslo, ktoré nikto neudržiava.
// Prepnutie na „Skladom" ho nepotrebuje — oba texty dostupnosti sa zapisujú
// naraz, takže je jedno, ktorý z nich Shoptet podľa zásoby vyberie.
describe("buildRestockCsv", () => {
  it("zapisuje obidva texty dostupnosti a ŽIADNU zásobu", () => {
    const csv = buildRestockCsv([
      { code: "A1", pairCode: "77", availabilityInStock: "Skladom", availabilityOutOfStock: "Skladom" },
    ]);
    const lines = csv.toString("utf8").slice(1).split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("code;pairCode;productVisibility;availabilityInStock;availabilityOutOfStock");
    expect(lines[1]).toBe("A1;77;visible;Skladom;Skladom");
  });

  it("odmietne prázdny zoznam — prázdny import do Shoptetu sa nikdy nenahráva", () => {
    expect(() => buildRestockCsv([])).toThrow(/žiadne riadky/);
  });
});

// issue 387 E7: stavový writeback — druhý, samostatný import (nikdy
// kombinovaný s linkovým `buildWritebackCsv` vyššie). Mapovanie stavov +
// stĺpce presne podľa starej appky (`import_builder.py`'s `state_rows`):
// unavailable → visible/0/Vypredané, discontinued → detailOnly/0/Predaj
// výrobku skončil. Stĺpce sú DISJUNKTNÉ od linkového CSV — žiadny
// `internalNote`, takže existujúce dodávateľské odkazy ostávajú nedotknuté.
describe("buildStatesCsv", () => {
  it("má stavovú hlavičku (disjunktnú od linkového CSV) + BOM + CRLF + ';' oddeľovač", () => {
    const csv = buildStatesCsv([{ code: "123/S", pairCode: "456", status: "unavailable" }]);
    const text = csv.toString("utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe("code;pairCode;productVisibility;stock;availabilityInStock;availabilityOutOfStock");
    expect(lines[1]).toBe("123/S;456;visible;0;Vypredané;Vypredané");
    expect(lines.at(-1)).toBe("");
  });

  it("mapuje 'unavailable' na visible/0/Vypredané (oba dostupnostné texty rovnaké)", () => {
    const csv = buildStatesCsv([{ code: "A", pairCode: "", status: "unavailable" }]);
    const rows = csv.toString("utf8").slice(1).split("\r\n").filter(Boolean);
    expect(rows[1]).toBe("A;;visible;0;Vypredané;Vypredané");
  });

  it("mapuje 'discontinued' na detailOnly/0/Predaj výrobku skončil (oba texty rovnaké)", () => {
    const csv = buildStatesCsv([{ code: "B", pairCode: "77", status: "discontinued" }]);
    const rows = csv.toString("utf8").slice(1).split("\r\n").filter(Boolean);
    expect(rows[1]).toBe("B;77;detailOnly;0;Predaj výrobku skončil;Predaj výrobku skončil");
  });

  it("odmietne prázdny zoznam — prázdny import do Shoptetu sa nikdy nenahráva", () => {
    expect(() => buildStatesCsv([])).toThrow(/žiadne riadky/i);
  });

  // issue 153: rovnaká CSV-injection ochrana ako `buildWritebackCsv` —
  // `code`/`pairCode` prichádzajú z katalógového importu bez inej kontroly.
  it("neutralizuje bunku začínajúcu znakom vzorca v KTOROMKOĽVEK stĺpci", () => {
    const csv = buildStatesCsv([{ code: "=SUM(A1:A9)", pairCode: "+1", status: "unavailable" }]);
    const rows = csv.toString("utf8").slice(1).split("\r\n").filter(Boolean);
    expect(rows[1]).toBe("'=SUM(A1:A9);'+1;visible;0;Vypredané;Vypredané");
  });

  // Dedup podľa `code`, PRVÝ vyhráva — stará appka's zákon
  // (`import_builder.py`'s `state_rows`/`link_rows`: Shoptet aborduje celý
  // import na duplicitnom kóde). V tejto appke je `variants.code` DB
  // primárny kľúč, takže skutočný duplikát je štrukturálne nedosiahnuteľný
  // pri korektnom volajúcom — táto funkcia je obranná vrstva navyše.
  it("dedupuje podľa 'code' — prvý výskyt vyhráva, druhý (aj s iným stavom) sa zahodí", () => {
    const csv = buildStatesCsv([
      { code: "DUP", pairCode: "1", status: "unavailable" },
      { code: "DUP", pairCode: "2", status: "discontinued" },
      { code: "OK", pairCode: "3", status: "discontinued" },
    ]);
    const rows = csv.toString("utf8").slice(1).split("\r\n").filter(Boolean);
    expect(rows).toEqual([
      "code;pairCode;productVisibility;stock;availabilityInStock;availabilityOutOfStock",
      "DUP;1;visible;0;Vypredané;Vypredané",
      "OK;3;detailOnly;0;Predaj výrobku skončil;Predaj výrobku skončil",
    ]);
  });
});

describe("dedupeStateRowsByCode", () => {
  it("necháva neduplicitné riadky bezo zmeny (rovnaký poradie)", () => {
    const rows = [
      { code: "A", pairCode: "", status: "unavailable" as const },
      { code: "B", pairCode: "", status: "discontinued" as const },
    ];
    expect(dedupeStateRowsByCode(rows)).toEqual(rows);
  });

  it("zahodí KAŽDÝ ďalší výskyt toho istého 'code', zachová prvý", () => {
    const rows = [
      { code: "X", pairCode: "1", status: "unavailable" as const },
      { code: "X", pairCode: "2", status: "unavailable" as const },
      { code: "X", pairCode: "3", status: "unavailable" as const },
    ];
    expect(dedupeStateRowsByCode(rows)).toEqual([{ code: "X", pairCode: "1", status: "unavailable" }]);
  });

  it("je no-op pre prázdny zoznam", () => {
    expect(dedupeStateRowsByCode([])).toEqual([]);
  });
});
