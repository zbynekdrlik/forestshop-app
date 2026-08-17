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

// issue 442: ročne opakovaná udalosť (napr. narodeniny) — v suite dosiaľ
// žiadny FREQ=YEARLY fixture. Šéf: "26. 2." v auguste vyzeralo ako minulosť,
// hoci najbližší výskyt je 26. 2. BUDÚCEHO roka. `formatDateLabel` preto pri
// výskyte v inom kalendárnom roku než dnešok pripojí ROK; tohtoročný výskyt
// ostáva bez roka (žiadna vizuálna zmena tam, kde nebola vypýtaná).
describe("resolveNextEvents — ročné (FREQ=YEARLY) + rok v popisku (issue 442)", () => {
  it("ročná celodenná udalosť (narodeniny) vyberie NAJBLIŽŠÍ BUDÚCI výskyt a popisok nesie ROK, keď je výskyt v budúcom roku", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:narodeniny@test",
      "DTSTAMP:20240101T000000Z",
      "SUMMARY:Narodeniny Adriana",
      "DTSTART;VALUE=DATE:20240226",
      "DTEND;VALUE=DATE:20240227",
      "RRULE:FREQ=YEARLY",
      "END:VEVENT",
    ]);
    // NOW = sobota 2026-08-08 → 2026-02-26 UŽ prešlo, najbližší výskyt je
    // 2027-02-26 (piatok, budúci rok). Rok sa preto v popisku UKÁŽE.
    const result = next(text);
    expect(result).toEqual({ title: "Narodeniny Adriana", dateLabel: "piatok 26. 2. 2027", allDay: true });
  });

  it("ročná udalosť s najbližším výskytom v AKTUÁLNOM roku ostáva BEZ roka", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:rocna-tento-rok@test",
      "DTSTAMP:20200101T000000Z",
      "SUMMARY:Výročie",
      "DTSTART;TZID=Europe/Bratislava:20200910T090000",
      "DTEND;TZID=Europe/Bratislava:20200910T093000",
      "RRULE:FREQ=YEARLY",
      "END:VEVENT",
    ]);
    // NOW = 2026-08-08 → najbližší výskyt 2026-09-10 (štvrtok, TENTO rok) →
    // popisok BEZ roka, presne ako doteraz.
    const result = next(text);
    expect(result?.dateLabel).toBe("štvrtok 10. 9.");
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

// issue 439: majiteľ chce 3 najbližšie DNI, v ktorých je nejaká udalosť, a v
// každom dni VŠETKY jeho udalosti — `limit` (teraz `dayLimit`) počíta DNI, nie
// udalosti. Dni bez udalosti sa preskakujú a nepočítajú sa do troch.
describe("resolveNextEvents — zoskupenie po dňoch (issue 439)", () => {
  function evt(uid: string, summary: string, startLocal: string, endLocal: string): readonly string[] {
    return [
      "BEGIN:VEVENT",
      `UID:${uid}@test`,
      "DTSTAMP:20260101T000000Z",
      `SUMMARY:${summary}`,
      `DTSTART;TZID=Europe/Bratislava:${startLocal}`,
      `DTEND;TZID=Europe/Bratislava:${endLocal}`,
      "END:VEVENT",
    ];
  }

  it("viac udalostí v JEDEN deň sa vráti VŠETKY (jeden deň = jeden slot), zoradené v rámci dňa", () => {
    const text = ics([
      ...evt("a", "Deň1 skoro", "20260810T090000", "20260810T100000"),
      ...evt("b", "Deň1 neskôr", "20260810T140000", "20260810T150000"),
      ...evt("c", "Deň2", "20260811T090000", "20260811T100000"),
    ]);
    const result = resolveNextEvents(text, NOW, 3);
    expect(result.map((e) => e.title)).toEqual(["Deň1 skoro", "Deň1 neskôr", "Deň2"]);
    expect(result.map((e) => e.dateLabel)).toEqual(["pondelok 10. 8.", "pondelok 10. 8.", "utorok 11. 8."]);
  });

  it("dayLimit počíta DNI, nie udalosti — 4 dni po 1 udalosti, dayLimit 3 → len prvé 3 dni", () => {
    const text = ics([
      ...evt("d1", "Deň 9", "20260809T090000", "20260809T100000"),
      ...evt("d2", "Deň 10", "20260810T090000", "20260810T100000"),
      ...evt("d3", "Deň 11", "20260811T090000", "20260811T100000"),
      ...evt("d4", "Deň 12", "20260812T090000", "20260812T100000"),
    ]);
    const result = resolveNextEvents(text, NOW, 3);
    expect(result.map((e) => e.title)).toEqual(["Deň 9", "Deň 10", "Deň 11"]);
  });

  it("dni bez udalosti sa PRESKAKUJÚ a nepočítajú sa do troch (medzery medzi dňami)", () => {
    const text = ics([
      ...evt("g1", "9.8.", "20260809T090000", "20260809T100000"),
      ...evt("g2", "13.8.", "20260813T090000", "20260813T100000"),
      ...evt("g3", "20.8.", "20260820T090000", "20260820T100000"),
    ]);
    const result = resolveNextEvents(text, NOW, 3);
    // Prázdne dni (10., 11., 12., 14.–19. 8.) neminú limit — vrátia sa všetky 3.
    expect(result.map((e) => e.title)).toEqual(["9.8.", "13.8.", "20.8."]);
    expect(result.map((e) => e.dateLabel)).toEqual(["nedeľa 9. 8.", "štvrtok 13. 8.", "štvrtok 20. 8."]);
  });

  it("viac dní, každý s viacerými udalosťami — dayLimit oreže na počet DNÍ, vráti všetky udalosti tých dní", () => {
    const text = ics([
      ...evt("x1", "D9 a", "20260809T110000", "20260809T120000"),
      ...evt("x2", "D9 b", "20260809T080000", "20260809T090000"),
      ...evt("x3", "D11 a", "20260811T090000", "20260811T100000"),
      ...evt("x4", "D11 b", "20260811T130000", "20260811T140000"),
      ...evt("x5", "D13 (mimo limitu)", "20260813T090000", "20260813T100000"),
    ]);
    const result = resolveNextEvents(text, NOW, 2);
    // Prvé 2 DNI (9. a 11.), každý so všetkými udalosťami, v rámci dňa zoradené; 13. je mimo.
    expect(result.map((e) => e.title)).toEqual(["D9 b", "D9 a", "D11 a", "D11 b"]);
  });

  it("jeden deň s VIAC udalosťami než dayLimit → dayLimit 1 vráti VŠETKY udalosti toho JEDNÉHO dňa (nie len 1)", () => {
    const text = ics([
      ...evt("m1", "U1", "20260810T080000", "20260810T090000"),
      ...evt("m2", "U2", "20260810T100000", "20260810T110000"),
      ...evt("m3", "U3", "20260810T120000", "20260810T130000"),
      ...evt("m4", "U4", "20260810T140000", "20260810T150000"),
    ]);
    const result = resolveNextEvents(text, NOW, 1);
    expect(result.map((e) => e.title)).toEqual(["U1", "U2", "U3", "U4"]);
  });

  it("celodenné (VALUE=DATE) aj časované udalosti v ten istý deň sa zoskupia spolu", () => {
    const text = ics([
      "BEGIN:VEVENT",
      "UID:allday@test",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:Celodenná 10.8.",
      "DTSTART;VALUE=DATE:20260810",
      "DTEND;VALUE=DATE:20260811",
      "END:VEVENT",
      ...evt("timed", "Časovaná 10.8.", "20260810T150000", "20260810T160000"),
    ]);
    const result = resolveNextEvents(text, NOW, 3);
    // Oba pod 10. 8. — jeden deň, celodenná začína na hranici dňa (skôr), časovaná neskôr.
    expect(result.map((e) => e.title)).toEqual(["Celodenná 10.8.", "Časovaná 10.8."]);
    expect(result.every((e) => e.dateLabel === "pondelok 10. 8.")).toBe(true);
  });
});

// issue 382: majiteľ chce vidieť TRI najbližšie udalosti, nie jednu. (issue 439
// zmenilo význam `limit` na POČET DNÍ — tieto fixtúry majú každú udalosť v INÝ
// deň, takže výsledok ostáva rovnaký a testy platia bezo zmeny.)
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
