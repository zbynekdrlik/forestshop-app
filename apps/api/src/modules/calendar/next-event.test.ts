import { describe, expect, it } from "vitest";
import { resolveNextEvent } from "./next-event.js";

// issue 309: čisté testy nad ICS textom — ŽIADNY test v tomto module (ani v
// tomto súbore) sa NIKDY nepripája na skutočný Google, presne rovnaká
// disciplína ako Shoptet/Pošta SK/dodávateľské stránky/DPD portál
// (`.claude/rules/testing.md`).

function ics(lines: readonly string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
}

const NOW = new Date("2026-08-08T10:00:00Z");

describe("resolveNextEvent — základné prípady", () => {
  it("prázdny kalendár (0 udalostí) vráti null", () => {
    expect(resolveNextEvent(ics([]), NOW)).toBeNull();
  });

  it("obsah bez BEGIN:VCALENDAR je nahlas považovaný za pokazený feed", () => {
    expect(() => resolveNextEvent("toto nie je ICS vôbec", NOW)).toThrow(/BEGIN:VCALENDAR/);
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
    const result = resolveNextEvent(text, NOW);
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
    expect(resolveNextEvent(text, NOW)).toBeNull();
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
    const result = resolveNextEvent(text, NOW);
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
    const result = resolveNextEvent(text, NOW);
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
    expect(resolveNextEvent(text, NOW)).toBeNull();
  });
});

describe("resolveNextEvent — celodenné (VALUE=DATE) udalosti", () => {
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
    const result = resolveNextEvent(text, NOW);
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
    expect(resolveNextEvent(text, NOW)).toBeNull();
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
    const result = resolveNextEvent(text, NOW);
    expect(result?.dateLabel).toBe("streda 12. 8.");
  });
});

describe("resolveNextEvent — opakujúce sa udalosti (RRULE)", () => {
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
    const result = resolveNextEvent(text, NOW);
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
    const result = resolveNextEvent(text, NOW);
    expect(result?.dateLabel).toBe("pondelok 17. 8.");
  });
});

describe("resolveNextEvent — viacero VEVENT typov naraz", () => {
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
    const result = resolveNextEvent(text, NOW);
    expect(result?.title).toBe("Jednorazová skoro");
  });
});
