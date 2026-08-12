import { describe, expect, it } from "vitest";
import { resolveNextEvents } from "./next-event.js";

// issue 309: čisté testy nad ICS textom — ŽIADNY test v tomto module (ani v
// tomto súbore) sa NIKDY nepripája na skutočný Google, presne rovnaká
// disciplína ako Shoptet/Pošta SK/dodávateľské stránky/DPD portál
// (`.claude/rules/testing.md`).
//
// issue 382: `resolveNextEvent` (jedna udalosť) sa premenovalo na
// `resolveNextEvents` (pole, max `limit`) — majiteľ chce vidieť TRI
// najbližšie, nie jednu. Existujúce testy pod jednou udalosťou volajú
// `next()` (limit 1, vezme prvý prvok poľa) — nová logika (poradie,
// filtrovanie) je nezmenená, len vracia pole namiesto singulárnej hodnoty.

function ics(lines: readonly string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
}

const NOW = new Date("2026-08-08T10:00:00Z");

function next(icsText: string) {
  return resolveNextEvents(icsText, NOW, 1)[0] ?? null;
}

describe("resolveNextEvents — základné prípady", () => {
  it("prázdny kalendár (0 udalostí) vráti prázdne pole", () => {
    expect(resolveNextEvents(ics([]), NOW, 3)).toEqual([]);
  });

  it("obsah bez BEGIN:VCALENDAR je nahlas považovaný za pokazený feed", () => {
    expect(() => resolveNextEvents("toto nie je ICS vôbec", NOW, 3)).toThrow(/BEGIN:VCALENDAR/);
  });

  it("jedna časovaná (TZID) udalosť v budúcnosti sa vráti s dateLabel a allDay:false", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:e1@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Stretnutie s dodávateľom",
      "DTSTART;TZID=Europe/Bratislava:20260812T090000",
      "DTEND;TZID=Europe/Bratislava:20260812T100000",
      "END:VEVENT",
    ]);
    const result = next(text);
    expect(result).toEqual({ title: "Stretnutie s dodávateľom", dateLabel: "streda 12. 8.", allDay: false });
  });

  it("udalosť, ktorá už SKONČILA (end < now), sa NIKDY nevráti ako najbližšia", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:minula@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Minulá udalosť",
      "DTSTART;TZID=Europe/Bratislava:20260801T090000",
      "DTEND;TZID=Europe/Bratislava:20260801T100000",
      "END:VEVENT",
    ]);
    expect(next(text)).toBeNull();
  });

  it("PREBIEHAJÚCA udalosť (začala pred `now`, ešte neskončila) sa počíta ako najbližšia — dispatch: 'najbližšia = neskončila'", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:prebieha@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Prebiehajúca schôdza",
      "DTSTART;TZID=Europe/Bratislava:20260808T090000",
      "DTEND;TZID=Europe/Bratislava:20260808T140000",
      "END:VEVENT",
    ]);
    const result = next(text);
    expect(result?.title).toBe("Prebiehajúca schôdza");
  });

  it("z viacerých budúcich udalostí vyberie tú s NAJSKORŠÍM začiatkom", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:neskorsia@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Neskoršia",
      "DTSTART;TZID=Europe/Bratislava:20260820T090000",
      "DTEND;TZID=Europe/Bratislava:20260820T100000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:skorsia@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Skoršia",
      "DTSTART;TZID=Europe/Bratislava:20260810T090000",
      "DTEND;TZID=Europe/Bratislava:20260810T100000",
      "END:VEVENT",
    ]);
    const result = next(text);
    expect(result?.title).toBe("Skoršia");
  });

  it("zrušená (STATUS:CANCELLED) udalosť sa nikdy nevráti", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:zrusena@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Zrušené stretnutie",
      "DTSTART;TZID=Europe/Bratislava:20260810T090000",
      "DTEND;TZID=Europe/Bratislava:20260810T100000",
      "STATUS:CANCELLED",
      "END:VEVENT",
    ]);
    expect(next(text)).toBeNull();
  });
});

describe("resolveNextEvents — celodenné (VALUE=DATE) udalosti", () => {
  it("celodenná udalosť DNES sa počíta ako neskončená (end je exkluzívna hranica nasledujúceho dňa)", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:cely-den-dnes@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Sviatok",
      "DTSTART;VALUE=DATE:20260808",
      "DTEND;VALUE=DATE:20260809",
      "END:VEVENT",
    ]);
    const result = next(text);
    expect(result?.title).toBe("Sviatok");
    expect(result?.allDay).toBe(true);
  });

  it("celodenná udalosť VČERA (end == dnešný deň, exkluzívna) je už skončená", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:cely-den-vcera@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Včerajší sviatok",
      "DTSTART;VALUE=DATE:20260807",
      "DTEND;VALUE=DATE:20260808",
      "END:VEVENT",
    ]);
    expect(next(text)).toBeNull();
  });

  it("dateLabel má presne tvar 'deň dátum. mesiac.' v slovenčine", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:format@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Formátovacia udalosť",
      "DTSTART;VALUE=DATE:20260812",
      "DTEND;VALUE=DATE:20260813",
      "END:VEVENT",
    ]);
    const result = next(text);
    expect(result?.dateLabel).toBe("streda 12. 8.");
  });
});

describe("resolveNextEvents — opakujúce sa udalosti (RRULE)", () => {
  it("týždenne opakujúca sa udalosť vráti NAJBLIŽŠIU budúcu inštanciu, nie prvý výskyt v minulosti", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:tyzdenna@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Týždenná porada",
      "DTSTART;TZID=Europe/Bratislava:20260101T090000",
      "DTEND;TZID=Europe/Bratislava:20260101T093000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "END:VEVENT",
    ]);
    const result = next(text);
    // NOW = streda 2026-08-08 10:00 UTC → najbližší pondelok je 2026-08-10.
    expect(result?.title).toBe("Týždenná porada");
    expect(result?.dateLabel).toBe("pondelok 10. 8.");
  });

  it("vynechaný výskyt (EXDATE) sa preskočí, vyberie sa ĎALŠÍ v poradí", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:tyzdenna-exdate@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Týždenná porada",
      "DTSTART;TZID=Europe/Bratislava:20260101T090000",
      "DTEND;TZID=Europe/Bratislava:20260101T093000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "EXDATE;TZID=Europe/Bratislava:20260810T090000",
      "END:VEVENT",
    ]);
    const result = next(text);
    expect(result?.dateLabel).toBe("pondelok 17. 8.");
  });
});

describe("resolveNextEvents — viacero VEVENT typov naraz", () => {
  it("kombinácia jednorazovej + opakujúcej sa udalosti vyberie skutočne najbližšiu z OBOCH", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:jednorazova@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Jednorazová skoro",
      "DTSTART;TZID=Europe/Bratislava:20260809T090000",
      "DTEND;TZID=Europe/Bratislava:20260809T100000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:tyzdenna2@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Opakujúca sa neskôr",
      "DTSTART;TZID=Europe/Bratislava:20260101T090000",
      "DTEND;TZID=Europe/Bratislava:20260101T093000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "END:VEVENT",
    ]);
    const result = next(text);
    expect(result?.title).toBe("Jednorazová skoro");
  });
});

// issue 382: majiteľ chce vidieť TRI najbližšie udalosti, nie jednu.
describe("resolveNextEvents — limit (issue 382)", () => {
  function threeFutureEvents(): string {
    return ics([
      "BEGIN:VEVENT",
      "UID:prva@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Prvá",
      "DTSTART;TZID=Europe/Bratislava:20260809T090000",
      "DTEND;TZID=Europe/Bratislava:20260809T100000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:druha@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Druhá",
      "DTSTART;TZID=Europe/Bratislava:20260810T090000",
      "DTEND;TZID=Europe/Bratislava:20260810T100000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:tretia@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Tretia",
      "DTSTART;TZID=Europe/Bratislava:20260811T090000",
      "DTEND;TZID=Europe/Bratislava:20260811T100000",
      "END:VEVENT",
    ]);
  }

  it("vráti až `limit` najbližších udalostí, ZORADENÉ podľa najskoršieho začiatku", () => {
    const result = resolveNextEvents(threeFutureEvents(), NOW, 3);
    expect(result.map((e) => e.title)).toEqual(["Prvá", "Druhá", "Tretia"]);
  });

  it("keď je dostupných udalostí MENEJ než `limit`, vráti len toľko, koľko naozaj je (nikdy sa nedopĺňa)", () => {
    const result = resolveNextEvents(threeFutureEvents(), NOW, 10);
    expect(result).toHaveLength(3);
  });

  it("keď je dostupných udalostí VIAC než `limit`, orezáva sa presne na `limit`, nikdy viac", () => {
    const result = resolveNextEvents(threeFutureEvents(), NOW, 2);
    expect(result.map((e) => e.title)).toEqual(["Prvá", "Druhá"]);
  });

  it("`limit: 1` sa správa rovnako ako pôvodná singulárna funkcia (prvý prvok poľa)", () => {
    const result = resolveNextEvents(threeFutureEvents(), NOW, 1);
    expect(result).toEqual([{ title: "Prvá", dateLabel: "nedeľa 9. 8.", allDay: false }]);
  });
});
