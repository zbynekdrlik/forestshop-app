import { describe, expect, it } from "vitest";
import {
  entryKey,
  hasLogEntries,
  logEntryId,
  parseImportLog,
  pickResultRow,
  resultExitCode,
} from "./log-attribution.js";

describe("entryKey", () => {
  it("uses Shoptet's own '#id' when the row carries one", () => {
    expect(entryKey("#12689 26.07.2026 21:00 Spracované: 4.")).toBe("12689");
  });
  it("falls back to the raw row text when there is no '#id'", () => {
    expect(entryKey("bez čísla — starší formát riadku")).toBe("bez čísla — starší formát riadku");
  });
});

describe("logEntryId", () => {
  it("reads Shoptet's own leading '#N' entry id", () => {
    expect(logEntryId("#12689 26.07.2026 21:00 Spracované: 4. Upravené: 1.")).toBe(12689);
  });
  it("returns null when the row carries no leading id", () => {
    expect(logEntryId("Dátum Výsledok")).toBeNull();
    expect(logEntryId("obsahuje #42 niekde vnútri, nie na začiatku")).toBeNull();
  });
});

describe("parseImportLog", () => {
  it("extracts processed/updated/failed counts (Slovak 'Spracované'/'Upravené'/'Zlyhanie')", () => {
    const parsed = parseImportLog("Spracované: 4. Upravené: 1. Zlyhanie variantov: 0.");
    expect(parsed.processed).toBe(4);
    expect(parsed.updated).toBe(1);
    expect(parsed.failed).toBe(0);
    expect(parsed.errorDetail).toBeNull();
  });
  it("also parses the Czech 'Zpracováno' spelling", () => {
    expect(parseImportLog("Zpracováno: 1. Upraveno: 1.").processed).toBe(1);
  });
  it("surfaces a hard Shoptet error with no summary at all as errorDetail", () => {
    const parsed = parseImportLog("Chyba | Číslo riadku: 42 - Data in column code are not unique");
    expect(parsed.processed).toBeNull();
    expect(parsed.errorDetail).toContain("Data in column code are not unique");
  });
  it("does not mistake the harmless 'skončil s chybou' prose for a hard error when a summary is present", () => {
    const parsed = parseImportLog("Import skončil s chybou. Spracované: 4. Zlyhanie variantov: 1.");
    expect(parsed.processed).toBe(4);
    expect(parsed.failed).toBe(1);
    expect(parsed.errorDetail).toBeNull();
  });
});

describe("hasLogEntries", () => {
  it("is true when at least one row looks like a genuine log entry", () => {
    expect(hasLogEntries(["Dátum Výsledok", "#1 Spracované: 1."])).toBe(true);
  });
  it("is false for header-only / empty page chrome", () => {
    expect(hasLogEntries(["Dátum Výsledok"])).toBe(false);
    expect(hasLogEntries([])).toBe(false);
  });
});

describe("pickResultRow — baseline + expected-rows attribution", () => {
  const baseline = "#100 25.07.2026 10:00 Spracované: 2. Upravené: 2.";
  const rowsNewestFirst = (...rows: string[]) => rows;

  it("returns null when nothing new appeared since the baseline", () => {
    expect(pickResultRow(rowsNewestFirst(baseline), { baseline, expectedRows: 1 })).toBeNull();
  });

  it("picks the single new entry whose processed count matches expectedRows", () => {
    const ours = "#101 25.07.2026 10:05 Spracované: 1. Upravené: 1.";
    expect(pickResultRow(rowsNewestFirst(ours, baseline), { baseline, expectedRows: 1 })).toBe(ours);
  });

  it("returns null (ambiguous) when two new entries both match expectedRows", () => {
    const a = "#101 Spracované: 1. Upravené: 1.";
    const b = "#102 Spracované: 1. Upravené: 1.";
    expect(pickResultRow(rowsNewestFirst(b, a, baseline), { baseline, expectedRows: 1 })).toBeNull();
  });

  it("returns null when the baseline itself was unreadable — never attribute a stale row", () => {
    const stale = "#5 Spracované: 1.";
    expect(pickResultRow(rowsNewestFirst(stale), { baseline: null, expectedRows: 1 })).toBeNull();
  });

  it("attributes a single new HARD-error entry (no Spracované summary) when it is the only new row", () => {
    const err = "#101 Chyba | Číslo riadku: 3 - Data in column code are not unique";
    expect(pickResultRow(rowsNewestFirst(err, baseline), { baseline, expectedRows: 5 })).toBe(err);
  });
});

describe("resultExitCode", () => {
  it("is 0 only for a clean processed count with zero failures", () => {
    expect(resultExitCode(parseImportLog("Spracované: 3. Zlyhanie variantov: 0."))).toBe(0);
  });
  it("is non-zero when processed is unreadable", () => {
    expect(resultExitCode(parseImportLog(""))).not.toBe(0);
  });
  it("is non-zero when any row failed", () => {
    expect(resultExitCode(parseImportLog("Spracované: 3. Zlyhanie variantov: 1."))).not.toBe(0);
  });
});
