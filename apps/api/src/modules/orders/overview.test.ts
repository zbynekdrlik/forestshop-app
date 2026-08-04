import { describe, expect, it } from "vitest";
import { computeBratislavaPeriodBoundaries, sumMoneyCents } from "./overview.js";

describe("computeBratislavaPeriodBoundaries", () => {
  // 2026-08-04 12:00 UTC je v lete (CEST, UTC+2) 2026-08-04 14:00 miestneho —
  // "dnes" preto začína 2026-08-03T22:00:00Z (miestna polnoc).
  it("dnes = miestna polnoc (CEST, leto)", () => {
    const { today } = computeBratislavaPeriodBoundaries(new Date("2026-08-04T12:00:00Z"));
    expect(today.toISOString()).toBe("2026-08-03T22:00:00.000Z");
  });

  // 2026-08-04 je utorok — najbližší (predchádzajúci) pondelok je 2026-08-03,
  // ktorého miestna polnoc je 2026-08-02T22:00:00Z (o deň skôr než "dnes").
  it("týždeň = miestna polnoc najbližšieho pondelka", () => {
    const { week } = computeBratislavaPeriodBoundaries(new Date("2026-08-04T12:00:00Z"));
    expect(week.toISOString()).toBe("2026-08-02T22:00:00.000Z");
  });

  // Nedeľa je koniec ISO týždňa — pondelok toho istého týždňa je 6 dní SPÄŤ.
  // 2026-08-09 je nedeľa toho istého týždňa ako 2026-08-04 (utorok) vyššie —
  // obe musia ukázať na TEN ISTÝ pondelok (2026-08-03).
  it("týždeň v nedeľu ukazuje na pondelok toho istého týždňa (6 dní dozadu)", () => {
    const { week } = computeBratislavaPeriodBoundaries(new Date("2026-08-09T12:00:00Z"));
    expect(week.toISOString()).toBe("2026-08-02T22:00:00.000Z");
  });

  it("mesiac = miestna polnoc 1. dňa toho istého mesiaca", () => {
    const { month } = computeBratislavaPeriodBoundaries(new Date("2026-08-04T12:00:00Z"));
    expect(month.toISOString()).toBe("2026-07-31T22:00:00.000Z");
  });

  // Zimný čas (CET, UTC+1) — offset sa MUSÍ prejaviť inak než v lete.
  it("dnes = miestna polnoc (CET, zima)", () => {
    const { today } = computeBratislavaPeriodBoundaries(new Date("2026-01-15T12:00:00Z"));
    expect(today.toISOString()).toBe("2026-01-14T23:00:00.000Z");
  });

  // Prvý deň mesiaca je zároveň jeho vlastný začiatok.
  it("mesiac v 1. deň mesiaca je zhodný s dnes", () => {
    const now = new Date("2026-09-01T05:00:00Z");
    const { today, month } = computeBratislavaPeriodBoundaries(now);
    expect(month.toISOString()).toBe(today.toISOString());
  });
});

describe("sumMoneyCents", () => {
  it("sčíta zoznam kladných súm presne (bez plávajúcej čiarky)", () => {
    expect(sumMoneyCents(["238.20", "85.80", "0.00"])).toBe("324.00");
  });

  it("null hodnoty preskočí (nezaráta ako 0, nezhodí výpočet)", () => {
    expect(sumMoneyCents(["100.00", null, "50.50"])).toBe("150.50");
  });

  it("prázdny zoznam vráti 0.00", () => {
    expect(sumMoneyCents([])).toBe("0.00");
  });

  it("samé null vráti 0.00", () => {
    expect(sumMoneyCents([null, null])).toBe("0.00");
  });

  // Klasický binárny zaokrúhľovací problém (0.1 + 0.2 !== 0.3 v `number`) —
  // dôkaz, že súčet beží cez BigInt centy, nie cez plávajúcu čiarku.
  it("nestratí presnosť na hodnotách, ktoré cez number zaokrúhľujú nesprávne", () => {
    expect(sumMoneyCents(["0.10", "0.20"])).toBe("0.30");
  });

  it("záporná hodnota (storno) sa odpočíta správne", () => {
    expect(sumMoneyCents(["100.00", "-30.00"])).toBe("70.00");
  });

  it("veľký počet malých súm sa sčíta bez straty centu", () => {
    const values = Array.from({ length: 1000 }, () => "1.11");
    expect(sumMoneyCents(values)).toBe("1110.00");
  });
});
