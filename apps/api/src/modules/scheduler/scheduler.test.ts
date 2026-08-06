import { expect, it } from "vitest";
import { isDue } from "./scheduler.js";

// issue 293: `hourLocal`/`minuteLocal` sú Europe/Bratislava miestny čas
// (predtým `hourUtc`/`minuteUtc`, doslova UTC) — dátumové literály nižšie sú
// preto UTC okamihy zodpovedajúce miestnemu "01:00" na dátume 2026-07-29
// (letný čas, offset +2, teda "01:00 miestne" = "23:00 predošlý deň UTC").
const DAILY = { kind: "daily" as const, hourLocal: 1, minuteLocal: 0 };

it("daily: nie je splatná pred naplánovanou hodinou, keď ešte dnes nebežala", () => {
  expect(isDue(DAILY, new Date("2026-07-28T22:59:00Z"), null)).toBe(false);
});

it("daily: je splatná presne v naplánovanú minútu, keď ešte dnes nebežala", () => {
  expect(isDue(DAILY, new Date("2026-07-28T23:00:00Z"), null)).toBe(true);
});

it("daily: je splatná aj neskôr v ten istý deň, keď ešte nebežala", () => {
  expect(isDue(DAILY, new Date("2026-07-29T12:00:00Z"), null)).toBe(true);
});

it("daily: nie je splatná, keď už dnes bežala (bez ohľadu na hodinu posledného behu)", () => {
  expect(isDue(DAILY, new Date("2026-07-29T12:00:00Z"), { startedAt: new Date("2026-07-28T23:00:00Z") })).toBe(
    false,
  );
});

it("daily: je znova splatná ĎALŠÍ SLOVENSKÝ kalendárny deň, aj keď posledný beh bol len pár hodín predtým", () => {
  expect(isDue(DAILY, new Date("2026-07-29T23:00:00Z"), { startedAt: new Date("2026-07-29T21:00:00Z") })).toBe(
    true,
  );
});

it("daily: nie je splatná v ten istý SLOVENSKÝ kalendárny deň, aj keď posledný beh bol tesne pred naplánovanou minútou", () => {
  expect(isDue(DAILY, new Date("2026-07-28T23:05:00Z"), { startedAt: new Date("2026-07-28T22:59:59Z") })).toBe(
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

// issue 293: rozvrh musí počítať naplánovanú hodinu v Europe/Bratislava, nie
// v UTC — inak úloha nastavená na 7:00 skutočne bežala až o 9:00 (v zime
// 8:00) slovenského času. `DAILY_LOCAL`'s hodnota (7:00) je len ilustračná
// pre tento generický test `isDue()` — NEZODPOVEDÁ už aktuálnej hodnote
// `postaUncollectedJob` v `jobs.ts` (tá je od nasledujúceho tiketu 9:00, aby
// zostal zachovaný pôvodný zámer po oprave časového pásma).
const DAILY_LOCAL = { kind: "daily" as const, hourLocal: 7, minuteLocal: 0 };

it("issue 293: denná úloha na 7:00 je splatná o 7:00 SLOVENSKÉHO času v LETE (UTC+2)", () => {
  // 2026-08-06 07:00 Europe/Bratislava (letný čas, offset +2) = 05:00 UTC.
  expect(isDue(DAILY_LOCAL, new Date("2026-08-06T05:00:00Z"), null)).toBe(true);
  // O minútu skôr (04:59 slovenského času) ešte nie je splatná.
  expect(isDue(DAILY_LOCAL, new Date("2026-08-06T04:59:00Z"), null)).toBe(false);
});

it("issue 293: denná úloha na 7:00 je splatná o 7:00 SLOVENSKÉHO času v ZIME (UTC+1)", () => {
  // 2026-01-06 07:00 Europe/Bratislava (zimný čas, offset +1) = 06:00 UTC.
  expect(isDue(DAILY_LOCAL, new Date("2026-01-06T06:00:00Z"), null)).toBe(true);
  expect(isDue(DAILY_LOCAL, new Date("2026-01-06T05:59:00Z"), null)).toBe(false);
});

it("issue 293: denná úloha sa NEOPAKUJE dvakrát v ten istý SLOVENSKÝ deň, aj keď posledný beh bol tesne po miestnej polnoci (iný UTC kalendárny deň)", () => {
  // Posledný beh: 2026-08-06 00:10 Europe/Bratislava = 2026-08-05T22:10:00Z
  // (INÝ UTC kalendárny deň, ten istý slovenský deň). "Teraz": 2026-08-06
  // 14:00 Europe/Bratislava = 2026-08-06T12:00:00Z. Periodizačný kľúč MUSÍ
  // byť odvodený zo slovenského dňa, inak by tento druhý tick (UTC deň sa
  // medzitým zmenil) vyhodnotil úlohu ako znova splatnú a spustil ju
  // DRUHÝKRÁT v ten istý slovenský deň.
  const dailyEarly = { kind: "daily" as const, hourLocal: 0, minuteLocal: 5 };
  expect(
    isDue(dailyEarly, new Date("2026-08-06T12:00:00Z"), { startedAt: new Date("2026-08-05T22:10:00Z") }),
  ).toBe(false);
});

it("issue 293: denná úloha nie je PRESKOČENÁ v deň prechodu na LETNÝ čas (2026-03-29) oproti predošlému dňu", () => {
  // Posledný beh: 2026-03-28 07:00 (deň PRED prechodom) = 2026-03-28T06:00:00Z.
  // Teraz: 2026-03-29 07:00 (samotný deň prechodu, PO skoku 02:00→03:00) =
  // 2026-03-29T05:00:00Z. Nový slovenský deň → má byť znova splatná.
  expect(
    isDue(DAILY_LOCAL, new Date("2026-03-29T05:00:00Z"), { startedAt: new Date("2026-03-28T06:00:00Z") }),
  ).toBe(true);
});

it("issue 293: denná úloha sa NESPUSTÍ DVAKRÁT v samotný deň prechodu na letný čas, aj keď sa offset uprostred dňa zmenil", () => {
  // Posledný beh aj "teraz" sú OBA 2026-03-29 (deň prechodu), len rôzna
  // hodina — kľúč je čisto dátumový, offset zmena uprostred dňa nesmie
  // spôsobiť falošné "iný deň".
  expect(
    isDue(DAILY_LOCAL, new Date("2026-03-29T18:00:00Z"), { startedAt: new Date("2026-03-29T05:00:00Z") }),
  ).toBe(false);
});

it("issue 293: denná úloha nie je PRESKOČENÁ v deň prechodu na ZIMNÝ čas (2026-10-25) oproti predošlému dňu", () => {
  // Posledný beh: 2026-10-24 07:00 (deň PRED prechodom) = 2026-10-24T05:00:00Z.
  // Teraz: 2026-10-25 07:00 (samotný deň prechodu, PO skoku 03:00→02:00) =
  // 2026-10-25T06:00:00Z. Nový slovenský deň → má byť znova splatná.
  expect(
    isDue(DAILY_LOCAL, new Date("2026-10-25T06:00:00Z"), { startedAt: new Date("2026-10-24T05:00:00Z") }),
  ).toBe(true);
});

it("issue 293: denná úloha sa NESPUSTÍ DVAKRÁT v samotný deň prechodu na zimný čas, aj keď sa offset uprostred dňa zmenil", () => {
  expect(
    isDue(DAILY_LOCAL, new Date("2026-10-25T19:00:00Z"), { startedAt: new Date("2026-10-25T06:00:00Z") }),
  ).toBe(false);
});
