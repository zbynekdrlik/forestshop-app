import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAPSHOT_LIMITS,
  REQUIRED_COLUMNS,
  judgeSnapshot,
  type SnapshotCandidate,
} from "./validation.js";

const FULL_COLUMNS = [...REQUIRED_COLUMNS, "description", "guid"];

function candidate(overrides: Partial<SnapshotCandidate> = {}): SnapshotCandidate {
  return {
    columns: overrides.columns ?? FULL_COLUMNS,
    rowCount: overrides.rowCount ?? 14_014,
    byteSize: overrides.byteSize ?? 56_340_420,
    // `??` would treat an explicitly passed `null` (no previous snapshot) the
    // same as "not provided", silently reverting it to the default — checking
    // for `undefined` keeps an explicit `previousAccepted: null` intact.
    previousAccepted:
      overrides.previousAccepted !== undefined ? overrides.previousAccepted : { rowCount: 14_014 },
  };
}

describe("judgeSnapshot", () => {
  it("prijme plnohodnotný export", () => {
    expect(judgeSnapshot(candidate())).toEqual({ verdict: "accepted" });
  });

  // #281: export prišiel v plnej veľkosti, ale bez stĺpca `supplier` — dnešná
  // kontrola stĺpce vôbec nepozerá, takže prešiel a prepísal dobré dáta.
  it("odmietne export bez povinného stĺpca supplier (#281)", () => {
    const judgement = judgeSnapshot(
      candidate({ columns: FULL_COLUMNS.filter((c) => c !== "supplier") }),
    );
    expect(judgement.verdict).toBe("rejected");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("supplier");
  });

  it("v dôvode vymenuje všetky chýbajúce stĺpce naraz", () => {
    const judgement = judgeSnapshot(
      candidate({ columns: FULL_COLUMNS.filter((c) => c !== "supplier" && c !== "currency") }),
    );
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("currency");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("supplier");
  });

  // #277: skrátený export s 3 000 riadkami prešiel absolútnou hranicou 1 000
  // riadkov, hoci katalóg má 14 000 — hranica musí vychádzať z posledného
  // prijatého snapshotu, nie z konštanty.
  it("odmietne export skrátený na 3 000 zo 14 014 riadkov (#277)", () => {
    const judgement = judgeSnapshot(candidate({ rowCount: 3_000 }));
    expect(judgement.verdict).toBe("rejected");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("3000");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("11211");
  });

  it("prijme bežný pokles počtu riadkov v rámci 20 %", () => {
    expect(judgeSnapshot(candidate({ rowCount: 13_000 }))).toEqual({ verdict: "accepted" });
  });

  // #286: prázdne stiahnutie ticho prepísalo dobré dáta.
  it("odmietne prázdne telo (#286)", () => {
    const judgement = judgeSnapshot(candidate({ byteSize: 0, rowCount: 0 }));
    expect(judgement.verdict).toBe("rejected");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("prázdny");
  });

  it("odmietne neuveriteľne malé telo (#286)", () => {
    const judgement = judgeSnapshot(candidate({ byteSize: 512, rowCount: 2 }));
    expect(judgement.verdict).toBe("rejected");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("bajtov");
  });

  it("pri prvom importe použije absolútnu spodnú hranicu", () => {
    expect(judgeSnapshot(candidate({ previousAccepted: null, rowCount: 999 }))).toEqual({
      verdict: "rejected",
      reason: "Export má 999 riadkov, minimum pre prvý import je 1000.",
    });
    expect(judgeSnapshot(candidate({ previousAccepted: null, rowCount: 1_000 }))).toEqual({
      verdict: "accepted",
    });
  });

  it("uvoľnené limity umožnia prijať malú testovaciu fixtúru", () => {
    expect(
      judgeSnapshot(candidate({ byteSize: 92_000, rowCount: 35, previousAccepted: null }), {
        ...DEFAULT_SNAPSHOT_LIMITS,
        minByteSize: 1_000,
        absoluteMinRows: 10,
      }),
    ).toEqual({ verdict: "accepted" });
  });

  it("prázdne telo kontroluje skôr než stĺpce — dôvod musí byť ten zrozumiteľnejší", () => {
    const judgement = judgeSnapshot(candidate({ byteSize: 0, rowCount: 0, columns: [] }));
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("prázdny");
  });
});
