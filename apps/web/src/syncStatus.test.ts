import { expect, it } from "vitest";
import { computeSyncStatus, ORDERS_STALE_AFTER_MS, type SyncStatus } from "./syncStatus.js";
import type { JobRun } from "./schedulerApi.js";

// #115 (majiteľ: "sync zo shoptetu ma bezat kazdu hodinu, nemoze tam bezat ok
// ked posledny sync bol dni dozadu!!!") — dnes `SyncSection.tsx`'s pill
// rozhoduje LEN podľa `run?.status === "failure"`, vek behu sa nikde
// nekontroluje. `computeSyncStatus` je čistá funkcia nesúca TÚTO logiku —
// jediné miesto, ktoré rozhoduje "ok" vs. "zastaralé" vs. "chyba" vs. "nikdy".

const HOUR_MS = 60 * 60 * 1000;
const STALE_AFTER_MS = 2 * HOUR_MS; // rovnaká hranica ako issue's príklad ("~2 hodiny" pri hodinovej kadencii)

function run(overrides: Partial<JobRun> = {}): JobRun {
  return {
    jobName: "orders-import",
    startedAt: "2026-07-30T10:00:00.000Z",
    finishedAt: "2026-07-30T10:00:05.000Z",
    status: "success",
    detail: null,
    errorMessage: null,
    ...overrides,
  };
}

it("žiadny beh zatiaľ nebol → 'never', pill NIE JE 'on' (nesmie tváriť sa ako OK)", () => {
  const status: SyncStatus = computeSyncStatus(undefined, new Date("2026-07-30T10:00:00Z"), STALE_AFTER_MS);
  expect(status.kind).toBe("never");
  expect(status.pillClass).toBe("off");
  expect(status.warningText).toBeNull();
});

it("posledný beh SKONČIL CHYBOU → 'error', bez ohľadu na to, ako dávno bežal", () => {
  const status = computeSyncStatus(
    run({ status: "failure", errorMessage: "Import zlyhal", startedAt: "2026-07-30T09:59:00.000Z" }),
    new Date("2026-07-30T10:00:00Z"),
    STALE_AFTER_MS,
  );
  expect(status.kind).toBe("error");
  expect(status.pillClass).toBe("off");
});

it("posledný ÚSPEŠNÝ beh presne NA prahu (2h) je ešte 'ok'", () => {
  const now = new Date("2026-07-30T12:00:00Z");
  const status = computeSyncStatus(run({ startedAt: "2026-07-30T10:00:00.000Z" }), now, STALE_AFTER_MS);
  expect(status.kind).toBe("ok");
  expect(status.pillClass).toBe("on");
  expect(status.warningText).toBeNull();
});

it("posledný ÚSPEŠNÝ beh TESNE ZA prahom (2h + 1ms) je 'stale', nie 'ok'", () => {
  const now = new Date("2026-07-30T12:00:00.001Z");
  const status = computeSyncStatus(run({ startedAt: "2026-07-30T10:00:00.000Z" }), now, STALE_AFTER_MS);
  expect(status.kind).toBe("stale");
  expect(status.pillClass).toBe("off");
  expect(status.warningText).not.toBeNull();
});

it("posledný úspešný sync spred 3 dní → 'stale' s textom vrátane veku v dňoch", () => {
  const now = new Date("2026-07-30T10:00:00Z");
  const status = computeSyncStatus(run({ startedAt: "2026-07-27T10:00:00.000Z" }), now, STALE_AFTER_MS);
  expect(status.kind).toBe("stale");
  expect(status.warningText).toContain("Posledný úspešný sync");
  expect(status.warningText).toContain("3 dňami");
  expect(status.warningText).toContain("synchronizácia nebeží");
});

it("posledný úspešný sync spred 5 hodín (ešte v ten istý deň) → text vo formáte hodín, nie dní", () => {
  const now = new Date("2026-07-30T15:00:00Z");
  const status = computeSyncStatus(run({ startedAt: "2026-07-30T10:00:00.000Z" }), now, STALE_AFTER_MS);
  expect(status.kind).toBe("stale");
  expect(status.warningText).toContain("5 hodinami");
});

it("beh, ktorý ešte BEŽÍ ('running'), sa nepovažuje za zastaraný", () => {
  const status = computeSyncStatus(
    run({ status: "running", startedAt: "2026-07-01T00:00:00.000Z" }),
    new Date("2026-07-30T10:00:00Z"),
    STALE_AFTER_MS,
  );
  expect(status.kind).toBe("ok");
  expect(status.warningText).toBeNull();
});

// issue 589: import objednávok beží každých 15 minút — prah zastaranosti
// ostáva „2× kadencia", teda 30 min (predtým 2 h pri hodinovej kadencii).
it("issue 589: prah zastaranosti objednávok = 2× 15-min kadencia = 30 minút", () => {
  expect(ORDERS_STALE_AFTER_MS).toBe(30 * 60 * 1000);
  const start = "2026-10-02T10:00:00.000Z";
  const naHranici = computeSyncStatus(run({ startedAt: start }), new Date("2026-10-02T10:30:00Z"), ORDERS_STALE_AFTER_MS);
  expect(naHranici.kind).toBe("ok");
  const zaHranicou = computeSyncStatus(
    run({ startedAt: start }),
    new Date("2026-10-02T10:30:00.001Z"),
    ORDERS_STALE_AFTER_MS,
  );
  expect(zaHranicou.kind).toBe("stale");
});

it("issue 589: vek pod hodinu sa vypíše v minútach (nie '0 hodinami')", () => {
  const status = computeSyncStatus(
    run({ startedAt: "2026-10-02T10:00:00.000Z" }),
    new Date("2026-10-02T10:45:00Z"),
    ORDERS_STALE_AFTER_MS,
  );
  expect(status.kind).toBe("stale");
  expect(status.warningText).toContain("pred 45 minútami");
  expect(status.warningText).not.toContain("hodin");
});

it("issue 589: vek presne 1 minúta → 'minútou' (jednotné číslo)", () => {
  const status = computeSyncStatus(run({ startedAt: "2026-10-02T10:00:00.000Z" }), new Date("2026-10-02T10:01:00Z"), 0);
  expect(status.warningText).toContain("pred minútou");
});
