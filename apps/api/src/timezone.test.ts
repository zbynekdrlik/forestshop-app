import { expect, it } from "vitest";
import { getZonedDateParts, zonedDateKey, BRATISLAVA_TIME_ZONE } from "./timezone.js";

// issue 293: jediné spoločné miesto pre prácu s Europe/Bratislava pásmom —
// `scheduler.ts` aj `posta-uncollected/{state,run,logic}.ts` predtým počítali
// dátum/hodinu v UTC (`toISOString().slice(0,10)` / `getUTCHours()`), čo
// posunulo naplánované úlohy o 1-2 hodiny a zobrazovalo dátumy tesne pred
// polnocou slovenského času ako VČEREJŠOK.

it("BRATISLAVA_TIME_ZONE je Europe/Bratislava", () => {
  expect(BRATISLAVA_TIME_ZONE).toBe("Europe/Bratislava");
});

it("getZonedDateParts rozloží UTC okamih na miestne zložky v LETE (offset +2)", () => {
  expect(getZonedDateParts(new Date("2026-08-06T05:00:00Z"))).toEqual({
    year: 2026,
    month: 8,
    day: 6,
    hour: 7,
    minute: 0,
    second: 0,
  });
});

it("getZonedDateParts rozloží UTC okamih na miestne zložky v ZIME (offset +1)", () => {
  expect(getZonedDateParts(new Date("2026-01-06T06:00:00Z"))).toEqual({
    year: 2026,
    month: 1,
    day: 6,
    hour: 7,
    minute: 0,
    second: 0,
  });
});

it("zonedDateKey vráti DNEŠNÝ slovenský deň pre okamih tesne PO miestnej polnoci, aj keď je to ešte VČEREJŠÍ UTC kalendárny deň", () => {
  // 2026-08-05T22:10:00Z = 2026-08-06 00:10 Europe/Bratislava (letný čas).
  expect(zonedDateKey(new Date("2026-08-05T22:10:00Z"))).toBe("2026-08-06");
  // `toISOString().slice(0, 10)` (stará, nesprávna cesta) by tu vrátilo
  // "2026-08-05" — presne opačný, nesprávny deň.
});

it("zonedDateKey vráti VČEREJŠÍ slovenský deň pre okamih tesne PRED miestnou polnocou, aj keď je to už DNEŠNÝ UTC kalendárny deň", () => {
  // 2026-08-06T21:50:00Z = 2026-08-06 23:50 Europe/Bratislava (ešte ten istý
  // slovenský deň, UTC deň je zhodný — kontrolný prípad na hranicu).
  expect(zonedDateKey(new Date("2026-08-06T21:50:00Z"))).toBe("2026-08-06");
});

it("zonedDateKey funguje aj mimo predvoleného pásma, keď sa zadá explicitne", () => {
  expect(zonedDateKey(new Date("2026-08-06T05:00:00Z"), "UTC")).toBe("2026-08-06");
});
