import { describe, expect, it } from "vitest";
import { computeOrdersDashboardBoundaries, sumMoneyCents } from "./overview.js";

// issue 407: "Dnes" ostáva KALENDÁRNY deň (Europe/Bratislava miestna
// polnoc) — testy pre tento bucket sú nezmenené oproti pôvodnej verzii.
// "Týždeň"/"Mesiac" sú od issue 407 KĹZAVÉ (rolling) okná — `now - 7 dní` /
// `now - 1 kalendárny mesiac` — naživo overené proti Shoptet-ovmu vlastnému
// dashboardu (issue 407's komentár na tickete), NIE odhadnuté.
describe("computeOrdersDashboardBoundaries", () => {
  // 2026-08-04 12:00 UTC je v lete (CEST, UTC+2) 2026-08-04 14:00 miestneho —
  // "dnes" preto začína 2026-08-03T22:00:00Z (miestna polnoc).
  it("dnes = miestna polnoc (CEST, leto)", () => {
    const { today } = computeOrdersDashboardBoundaries(new Date("2026-08-04T12:00:00Z"));
    expect(today.toISOString()).toBe("2026-08-03T22:00:00.000Z");
  });

  // Zimný čas (CET, UTC+1) — offset sa MUSÍ prejaviť inak než v lete.
  it("dnes = miestna polnoc (CET, zima)", () => {
    const { today } = computeOrdersDashboardBoundaries(new Date("2026-01-15T12:00:00Z"));
    expect(today.toISOString()).toBe("2026-01-14T23:00:00.000Z");
  });

  // Kĺzavé okno — presne 7×24 hodín dozadu od `now`, žiadna TZ-konverzia
  // (čisté odčítanie trvania od okamihu, nie miestna polnoc).
  it("týždeň = presne 7 dní (168 hodín) dozadu od `now`", () => {
    const { week } = computeOrdersDashboardBoundaries(new Date("2026-08-04T12:00:00Z"));
    expect(week.toISOString()).toBe("2026-07-28T12:00:00.000Z");
  });

  // Kĺzavý kalendárny mesiac dozadu — 4.8. − 1 mesiac = 4.7. (júl má 31 dní,
  // žiadny clamp netreba).
  it("mesiac = presne 1 kalendárny mesiac dozadu od `now` (bez clampu)", () => {
    const { month } = computeOrdersDashboardBoundaries(new Date("2026-08-04T12:00:00Z"));
    expect(month.toISOString()).toBe("2026-07-04T12:00:00.000Z");
  });

  // Naživo overené priamo v produkčnej Postgres DB (issue 407's komentár):
  // `date '2026-03-31' - interval '1 month'` = `2026-02-28` (CLAMP na
  // posledný deň februára, nie prepad do marca ako by dal holý JS
  // `setUTCMonth`). 2026 nie je priestupný rok, február má 28 dní.
  //
  // Počíta sa v MIESTNOM (Bratislava) kalendári (code review na issue 407 —
  // pôvodný UTC-only pokus by pri tomto teste omylom nevidel, že "teraz"
  // (31.3., už letný čas CEST +2) a cieľový mesiac (február, ešte zimný čas
  // CET +1) majú ROZDIELNY offset) — miestny "12:00" (10:00 UTC + 2h CEST)
  // sa zachová a prevedie späť cez Februárov VLASTNÝ offset (+1), teda
  // `T11:00:00Z`, nie mechanicky rovnaké UTC hodiny ako "teraz" (`T10:00:00Z`).
  // Hodnota overená priamo behom skutočnej implementácie (Node), nie
  // odhadnutá ručne — presne to, čo toto pravidlo vyžaduje.
  it("mesiac CLAMPuje na posledný deň cieľového mesiaca (31.3. − 1 mesiac = 28.2., nie 3.3.) — cez DST hranicu", () => {
    const { month } = computeOrdersDashboardBoundaries(new Date("2026-03-31T10:00:00Z"));
    expect(month.toISOString()).toBe("2026-02-28T11:00:00.000Z");
  });

  // Priestupný rok — 2024 MÁ 29.2., clamp preto pristane na 29., nie 28.
  // Rovnaký DST-hranicový posun ako test vyššie (marec CEST, február CET).
  it("mesiac CLAMPuje na 29.2. v priestupnom roku — cez DST hranicu", () => {
    const { month } = computeOrdersDashboardBoundaries(new Date("2024-03-31T10:00:00Z"));
    expect(month.toISOString()).toBe("2024-02-29T11:00:00.000Z");
  });

  // Prechod cez hranicu roka — január nemá "predchádzajúci mesiac 0", musí
  // sa preklopiť na december PREDCHÁDZAJÚCEHO roka.
  it("mesiac prekleňuje hranicu roka (15.1. − 1 mesiac = 15.12. predchádzajúceho roka)", () => {
    const { month } = computeOrdersDashboardBoundaries(new Date("2026-01-15T12:00:00Z"));
    expect(month.toISOString()).toBe("2025-12-15T12:00:00.000Z");
  });

  // Code review na issue 407: presne ten prípad, ktorý by odhalil, keby
  // "mesiac"/"dnes" počítali v UTC namiesto v MIESTNOM kalendári. 31.8.
  // 22:30 UTC je v Bratislave (CEST, letný čas) UŽ 1.9. 00:30 — teda UTC
  // deň/mesiac (august) sa LÍŠI od miestneho (september). "Dnes" aj
  // "mesiac" musia vychádzať z MIESTNEHO kalendárneho dňa/mesiaca
  // (september), nie z UTC (august) — inak by appka počítala okno o celý
  // mesiac inak, presne v tomto dennom ~2-hodinovom okne (leto)/1-hodinovom
  // (zima). Hodnoty overené priamo behom implementácie (Node), nie ručne.
  it("dnes/mesiac používajú MIESTNY kalendárny deň/mesiac, nie UTC (31.8. 22:30 UTC = 1.9. 00:30 CEST)", () => {
    const { today, month } = computeOrdersDashboardBoundaries(new Date("2026-08-31T22:30:00Z"));
    expect(today.toISOString()).toBe("2026-08-31T22:00:00.000Z"); // miestna polnoc 1.9.
    expect(month.toISOString()).toBe("2026-07-31T22:30:00.000Z"); // miestny 1.9. mínus 1 mesiac = miestny 1.8.
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
