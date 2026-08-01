import { describe, expect, it } from "vitest";
import { buildWritebackCsv } from "./csv.js";

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
