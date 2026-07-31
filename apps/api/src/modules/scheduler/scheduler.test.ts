import { expect, it } from "vitest";
import { isDue } from "./scheduler.js";

const DAILY = { kind: "daily" as const, hourUtc: 1, minuteUtc: 0 };

it("daily: nie je splatná pred naplánovanou hodinou, keď ešte dnes nebežala", () => {
  expect(isDue(DAILY, new Date("2026-07-29T00:59:00Z"), null)).toBe(false);
});

it("daily: je splatná presne v naplánovanú minútu, keď ešte dnes nebežala", () => {
  expect(isDue(DAILY, new Date("2026-07-29T01:00:00Z"), null)).toBe(true);
});

it("daily: je splatná aj neskôr v ten istý deň, keď ešte nebežala", () => {
  expect(isDue(DAILY, new Date("2026-07-29T14:00:00Z"), null)).toBe(true);
});

it("daily: nie je splatná, keď už dnes bežala (bez ohľadu na hodinu posledného behu)", () => {
  expect(isDue(DAILY, new Date("2026-07-29T14:00:00Z"), { startedAt: new Date("2026-07-29T01:00:00Z") })).toBe(
    false,
  );
});

it("daily: je znova splatná ĎALŠÍ UTC kalendárny deň, aj keď posledný beh bol len pár hodín predtým", () => {
  expect(isDue(DAILY, new Date("2026-07-30T01:00:00Z"), { startedAt: new Date("2026-07-29T23:00:00Z") })).toBe(
    true,
  );
});

it("daily: nie je splatná v ten istý UTC kalendárny deň, aj keď posledný beh bol tesne pred naplánovanou minútou", () => {
  expect(isDue(DAILY, new Date("2026-07-29T01:05:00Z"), { startedAt: new Date("2026-07-29T00:59:59Z") })).toBe(
    false,
  );
});

// #115: hodinová kadencia (`kind: "hourly"`) — periodizuje podľa UTC dňa+
// hodiny namiesto celého dňa, takže je splatná znova v KAŽDEJ nasledujúcej
// hodine, nie len raz denne.
const HOURLY = { kind: "hourly" as const, minuteUtc: 45 };

it("hourly: nie je splatná pred naplánovanou minútou v tejto hodine, keď ešte v tejto hodine nebežala", () => {
  expect(isDue(HOURLY, new Date("2026-07-29T10:44:00Z"), null)).toBe(false);
});

it("hourly: je splatná presne v naplánovanú minútu, keď ešte v tejto hodine nebežala", () => {
  expect(isDue(HOURLY, new Date("2026-07-29T10:45:00Z"), null)).toBe(true);
});

it("hourly: nie je splatná, keď už v tejto UTC hodine bežala (bez ohľadu na minútu posledného behu)", () => {
  expect(isDue(HOURLY, new Date("2026-07-29T10:59:00Z"), { startedAt: new Date("2026-07-29T10:45:00Z") })).toBe(
    false,
  );
});

it("hourly: je znova splatná v NASLEDUJÚCEJ UTC hodine, aj keď posledný beh bol len pár minút predtým", () => {
  expect(isDue(HOURLY, new Date("2026-07-29T11:45:00Z"), { startedAt: new Date("2026-07-29T10:59:00Z") })).toBe(
    true,
  );
});

it("hourly: nie je splatná v tej istej UTC hodine, aj keď posledný beh bol tesne pred naplánovanou minútou", () => {
  expect(isDue(HOURLY, new Date("2026-07-29T10:46:00Z"), { startedAt: new Date("2026-07-29T10:44:59Z") })).toBe(
    false,
  );
});

it("hourly: je znova splatná pri prechode cez polnoc (nová UTC hodina 00 nasledujúceho dňa)", () => {
  expect(isDue(HOURLY, new Date("2026-07-30T00:45:00Z"), { startedAt: new Date("2026-07-29T23:45:00Z") })).toBe(
    true,
  );
});
