import { expect, it } from "vitest";
import { isDue } from "./scheduler.js";

const SCHEDULE = { hourUtc: 1, minuteUtc: 0 };

it("nie je splatná pred naplánovanou hodinou, keď ešte dnes nebežala", () => {
  expect(isDue(SCHEDULE, new Date("2026-07-29T00:59:00Z"), null)).toBe(false);
});

it("je splatná presne v naplánovanú minútu, keď ešte dnes nebežala", () => {
  expect(isDue(SCHEDULE, new Date("2026-07-29T01:00:00Z"), null)).toBe(true);
});

it("je splatná aj neskôr v ten istý deň, keď ešte nebežala", () => {
  expect(isDue(SCHEDULE, new Date("2026-07-29T14:00:00Z"), null)).toBe(true);
});

it("nie je splatná, keď už dnes bežala (bez ohľadu na hodinu posledného behu)", () => {
  expect(isDue(SCHEDULE, new Date("2026-07-29T14:00:00Z"), { startedAt: new Date("2026-07-29T01:00:00Z") })).toBe(
    false,
  );
});

it("je znova splatná ĎALŠÍ UTC kalendárny deň, aj keď posledný beh bol len pár hodín predtým", () => {
  expect(isDue(SCHEDULE, new Date("2026-07-30T01:00:00Z"), { startedAt: new Date("2026-07-29T23:00:00Z") })).toBe(
    true,
  );
});

it("nie je splatná v ten istý UTC kalendárny deň, aj keď posledný beh bol tesne pred naplánovanou minútou", () => {
  expect(isDue(SCHEDULE, new Date("2026-07-29T01:05:00Z"), { startedAt: new Date("2026-07-29T00:59:59Z") })).toBe(
    false,
  );
});
