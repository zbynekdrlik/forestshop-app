import { describe, expect, it } from "vitest";
import { splitDetailLines } from "./UpozornenieCard.js";

// issue 327 (code review pred mergom, finding 5): tabuľkový test na hraničné
// prípady `splitDetailLines`, ktoré `UpozorneniaSection.test.tsx`'s
// renderovacie testy pokrývajú len nepriamo (cez konkrétne fixtúry). Toto je
// ŠTRUKTURÁLNY split (prvý riadok / zvyšok podľa `\n`), nikdy parsovanie
// "Zákazník:" reťazca — pozri `UpozornenieCard.tsx`'s vlastný komentár.
describe("splitDetailLines", () => {
  it("prázdny reťazec: žiadny prvý riadok, prázdny zvyšok", () => {
    expect(splitDetailLines("")).toEqual({ first: null, rest: "" });
  });

  it("jeden riadok bez `\\n` (typický vlastný poznámkový text): celý sa stane 'prvým riadkom'", () => {
    expect(splitDetailLines("o 10:00 s dodávateľom")).toEqual({ first: "o 10:00 s dodávateľom", rest: "" });
  });

  it("dva riadky (typický automatický zdroj, 'Zákazník: X\\n...'): prvý oddelene, zvyšok bez neho", () => {
    expect(splitDetailLines("Zákazník: Ján Novák\nStav objednávky: Vratený tovar")).toEqual({
      first: "Zákazník: Ján Novák",
      rest: "Stav objednávky: Vratený tovar",
    });
  });

  it("viac riadkov: zvyšok zostáva spojený `\\n`, nie len posledný riadok", () => {
    expect(splitDetailLines("A\nB\nC")).toEqual({ first: "A", rest: "B\nC" });
  });

  it("reťazec je iba jeden `\\n`: prvý riadok je prázdny reťazec (nie null), zvyšok tiež prázdny", () => {
    expect(splitDetailLines("\n")).toEqual({ first: "", rest: "" });
  });

  it("prázdny prvý riadok pred skutočným obsahom: prvý je '' (volajúci ho vynechá, nikdy '· '), zvyšok nesie obsah", () => {
    expect(splitDetailLines("\nSkutočný obsah")).toEqual({ first: "", rest: "Skutočný obsah" });
  });
});
