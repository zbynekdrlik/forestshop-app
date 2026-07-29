import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAPSHOT_LIMITS,
  REQUIRED_COLUMNS,
  judgeSnapshot,
  type SnapshotCandidate,
} from "./validation.js";

const FULL_COLUMNS = [...REQUIRED_COLUMNS, "description", "guid"];

function candidate(overrides: Partial<SnapshotCandidate> = {}): SnapshotCandidate {
  // `??` would treat an explicitly passed `null` (e.g. a deliberately invalid
  // `columns: null` or "no previous snapshot") the same as "not provided",
  // silently reverting it to the default — checking for `undefined` keeps an
  // explicit `null` override intact, for every field, not just previousAccepted.
  return {
    columns: overrides.columns !== undefined ? overrides.columns : FULL_COLUMNS,
    rowCount: overrides.rowCount ?? 14_014,
    byteSize: overrides.byteSize ?? 56_340_420,
    malformedRowCount: overrides.malformedRowCount ?? 0,
    previousAccepted:
      overrides.previousAccepted !== undefined ? overrides.previousAccepted : { rowCount: 14_014 },
  };
}

describe("judgeSnapshot", () => {
  it("prijme plnohodnotný export", () => {
    expect(judgeSnapshot(candidate())).toEqual({ verdict: "accepted" });
  });

  // #281: export prišiel v plnej veľkosti, ale bez stĺpca `supplier` — dnešná
  // kontrola stĺpce vôbec nepozerá, takže prešiel a prepísal dobré dáta.
  it("odmietne export bez povinného stĺpca supplier (#281)", () => {
    const judgement = judgeSnapshot(
      candidate({ columns: FULL_COLUMNS.filter((c) => c !== "supplier") }),
    );
    expect(judgement.verdict).toBe("rejected");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("supplier");
  });

  it("v dôvode vymenuje všetky chýbajúce stĺpce naraz", () => {
    const judgement = judgeSnapshot(
      candidate({ columns: FULL_COLUMNS.filter((c) => c !== "supplier" && c !== "currency") }),
    );
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("currency");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("supplier");
  });

  // #277: skrátený export s 3 000 riadkami prešiel absolútnou hranicou 1 000
  // riadkov, hoci katalóg má 14 000 — hranica musí vychádzať z posledného
  // prijatého snapshotu, nie z konštanty.
  it("odmietne export skrátený na 3 000 zo 14 014 riadkov (#277)", () => {
    const judgement = judgeSnapshot(candidate({ rowCount: 3_000 }));
    expect(judgement.verdict).toBe("rejected");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("3000");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("11211");
  });

  it("prijme bežný pokles počtu riadkov v rámci 20 %", () => {
    expect(judgeSnapshot(candidate({ rowCount: 13_000 }))).toEqual({ verdict: "accepted" });
  });

  // #286: prázdne stiahnutie ticho prepísalo dobré dáta.
  it("odmietne prázdne telo (#286)", () => {
    const judgement = judgeSnapshot(candidate({ byteSize: 0, rowCount: 0 }));
    expect(judgement.verdict).toBe("rejected");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("prázdny");
  });

  it("odmietne neuveriteľne malé telo (#286)", () => {
    const judgement = judgeSnapshot(candidate({ byteSize: 512, rowCount: 2 }));
    expect(judgement.verdict).toBe("rejected");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("bajtov");
  });

  it("pri prvom importe použije absolútnu spodnú hranicu", () => {
    expect(judgeSnapshot(candidate({ previousAccepted: null, rowCount: 999 }))).toEqual({
      verdict: "rejected",
      reason:
        "Export má 999 riadkov, minimum pre prvý import je 1000. Katalóg zostáva nezmenený, import môžete kedykoľvek zopakovať.",
    });
    expect(judgeSnapshot(candidate({ previousAccepted: null, rowCount: 1_000 }))).toEqual({
      verdict: "accepted",
    });
  });

  it("uvoľnené limity umožnia prijať malú testovaciu fixtúru", () => {
    expect(
      judgeSnapshot(candidate({ byteSize: 92_000, rowCount: 35, previousAccepted: null }), {
        ...DEFAULT_SNAPSHOT_LIMITS,
        minByteSize: 1_000,
        absoluteMinRows: 10,
      }),
    ).toEqual({ verdict: "accepted" });
  });

  it("prázdne telo kontroluje skôr než stĺpce — dôvod musí byť ten zrozumiteľnejší", () => {
    const judgement = judgeSnapshot(candidate({ byteSize: 0, rowCount: 0, columns: [] }));
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("prázdny");
  });

  // CRITICAL: hranica odvodená z posledného prijatého importu sa použije SAMOSTATNE,
  // bez absolútneho minima ako podlahy — takže sa dá ratchetnúť až na nulu
  // (14014 → 11211 → 8968 → … → 1 → 0), a keď posledný prijatý mal 1 riadok,
  // floor(1 * 0.8) === 0, takže aj prázdny export (0 riadkov) prejde. Presne
  // scenár #286, tentoraz cez bránu, ktorá ho mala zastaviť.
  it("floor nesmie erodovať k nule — 0 riadkov s posledným prijatým = 1 riadok musí byť odmietnuté", () => {
    const judgement = judgeSnapshot(candidate({ rowCount: 0, previousAccepted: { rowCount: 1 } }));
    expect(judgement.verdict).toBe("rejected");
  });

  it("absolútna hranica platí aj keď je pomerová hranica nižšia (posledný prijatý mal 600, teraz 500)", () => {
    const judgement = judgeSnapshot(candidate({ rowCount: 500, previousAccepted: { rowCount: 600 } }));
    expect(judgement.verdict).toBe("rejected");
  });

  // Jedno nevyvážené úvodzovky v popise rozdelí riadok na dva — obidva plné
  // prázdnych polí. Počet riadkov len stúpne o jeden, čo pokojne prejde
  // pomerovou hranicou, takže poškodenie je inak neviditeľné. Gate musí toto
  // odmietnuť samostatne, nie spoliehať sa na to, že sa prejaví v počte riadkov.
  it("odmietne export s poškodenými riadkami, aj keď je všetko ostatné v poriadku", () => {
    const judgement = judgeSnapshot(candidate({ malformedRowCount: 1 }));
    expect(judgement.verdict).toBe("rejected");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("1 poškodený riadok");
  });

  // "1" ako holý podreťazec by prešiel aj nesprávnym tvarom ("1 poškodených
  // riadkov"), takže sa pripína celá fráza — 1 = jednotné číslo, 2-4 = malé
  // množstvo, 5+ = množné (genitív).
  it.each([
    [1, "1 poškodený riadok"],
    [3, "3 poškodené riadky"],
    [5, "5 poškodených riadkov"],
  ] as const)(
    "skloňuje počet poškodených riadkov v slovenčine: %i → %s",
    (malformedRowCount, expectedPhrase) => {
      const judgement = judgeSnapshot(candidate({ malformedRowCount }));
      expect(judgement.verdict === "rejected" && judgement.reason).toContain(expectedPhrase);
    },
  );

  it("malformedRowCount: 0 neprekáža prijatiu", () => {
    expect(judgeSnapshot(candidate({ malformedRowCount: 0 }))).toEqual({ verdict: "accepted" });
  });

  // Pomerová hranica (previous 14014 * 0.8 = floor 11211) je dnes testovaná len
  // nepriamo (#277 s rowCount 3000). Zámena `<` za `<=` by prešla celou sadou —
  // treba pripnúť presné hodnoty na oboch stranách hranice.
  it.each([
    [11_210, "rejected"],
    [11_211, "accepted"],
    [11_212, "accepted"],
  ] as const)("hranica pomeru: %i riadkov pri predchádzajúcich 14014 → %s", (rowCount, expected) => {
    const judgement = judgeSnapshot(candidate({ rowCount }));
    expect(judgement.verdict).toBe(expected);
  });

  // Poradie stĺpcov v exporte NIE JE garantované Shoptetom a gate ho zámerne
  // nekontroluje — kontrola je `Array.prototype.includes`, nie porovnanie polí.
  // Bez tohto testu by prepis na poradovo-citlivú kontrolu prešiel celou sadou a
  // zablokoval by každý nočný import v deň, keď Shoptet stĺpce preusporiada.
  it("poradie stĺpcov nehrá rolu — zamiešaný zoznam je prijatý", () => {
    const shuffled = [...FULL_COLUMNS].reverse();
    expect(judgeSnapshot(candidate({ columns: shuffled }))).toEqual({ verdict: "accepted" });
  });

  // Existujúce #286 testy menia byteSize AJ rowCount naraz, takže by ich odmietla
  // aj samotná pomerová hranica riadkov — dôvod je pripnutý len podreťazcom.
  // Tieto dva prípady izolujú bajtovú kontrolu: počet riadkov aj predchádzajúci
  // prijatý import zostávajú zdravé, takže odmietnuť môže JEDINE bajtová brána.
  it("bajtová brána izolovane: prázdne telo je odmietnuté aj pri zdravom počte riadkov", () => {
    const judgement = judgeSnapshot(candidate({ byteSize: 0 }));
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("prázdny");
  });

  it("bajtová brána izolovane: príliš malé telo je odmietnuté aj pri zdravom počte riadkov", () => {
    const judgement = judgeSnapshot(candidate({ byteSize: 512 }));
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("bajtov");
  });
});

// Každé porovnanie s NaN je false, takže bez explicitnej kontroly prejde každou
// bránou — treba zlyhať UZAVRETO (rejected), nikdy potichu prijať alebo vyhodiť
// nezachytenú výnimku z funkcie, ktorej zmluvou je vrátiť verdikt.
describe("judgeSnapshot — zlyhá uzavreto (fail closed) na neplatný vstup", () => {
  it("odmietne NaN v byteSize aj rowCount namiesto tichého prijatia", () => {
    const judgement = judgeSnapshot(candidate({ byteSize: NaN, rowCount: NaN }));
    expect(judgement.verdict).toBe("rejected");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("neplatné");
  });

  it("odmietne neplatný previousRowRatio v limitoch", () => {
    const judgement = judgeSnapshot(candidate(), {
      ...DEFAULT_SNAPSHOT_LIMITS,
      previousRowRatio: NaN,
    });
    expect(judgement.verdict).toBe("rejected");
  });

  // Reťazec spojený zo VŠETKÝCH povinných názvov obsahuje každý z nich ako podreťazec
  // — `Array.prototype.includes` na poli by to odmietlo (nie je to pole vôbec), no
  // `"reťazec".includes("meno")` sa správa ako podreťazcová zhoda a "vidí" všetky
  // stĺpce naraz. Presne toto by bez kontroly typu tichým omylom prešlo cez bránu.
  it("odmietne columns, ktoré nie sú pole, aj keď reťazec obsahuje všetky mená ako podreťazec", () => {
    const columnsAsString = REQUIRED_COLUMNS.join(",");
    const judgement = judgeSnapshot(candidate({ columns: columnsAsString as unknown as string[] }));
    expect(judgement.verdict).toBe("rejected");
  });

  it("odmietne columns: null namiesto vyhodenia výnimky", () => {
    expect(() => judgeSnapshot(candidate({ columns: null as unknown as string[] }))).not.toThrow();
    const judgement = judgeSnapshot(candidate({ columns: null as unknown as string[] }));
    expect(judgement.verdict).toBe("rejected");
  });
});

// #286 spôsobil výpadok práve preto, lebo nič v dôvode odmietnutia nepovedalo
// prevádzkovateľovi to najdôležitejšie: že katalóg NEBOL prepísaný a dáta sú
// v poriadku. Downstream automatizácie preto hlásili úspech, hoci dáta zmizli.
describe("judgeSnapshot — každý dôvod odmietnutia hovorí, čo sa stalo s katalógom", () => {
  const CONSEQUENCE = "Katalóg zostáva nezmenený, import môžete kedykoľvek zopakovať.";

  it.each([
    ["prázdne telo", candidate({ byteSize: 0, rowCount: 0 })],
    ["príliš malé telo", candidate({ byteSize: 512 })],
    ["chýbajúci stĺpec", candidate({ columns: FULL_COLUMNS.filter((c) => c !== "supplier") })],
    ["poškodené riadky", candidate({ malformedRowCount: 3 })],
    ["skrátený export", candidate({ rowCount: 3_000 })],
    ["prvý import pod hranicou", candidate({ previousAccepted: null, rowCount: 5 })],
    ["neplatný vstup", candidate({ byteSize: NaN })],
  ] as const)("%s → dôvod obsahuje dôsledok pre katalóg", (_popis, cand) => {
    const judgement = judgeSnapshot(cand);
    expect(judgement.verdict === "rejected" && judgement.reason).toContain(CONSEQUENCE);
  });
});

describe("judgeSnapshot — bajtová hranica je čitateľná, nie holé číslo", () => {
  it("formátuje minByteSize s medzerami po tisícoch namiesto 1000000", () => {
    const judgement = judgeSnapshot(candidate({ byteSize: 512 }));
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("1 000 000");
    expect(judgement.verdict === "rejected" && judgement.reason).not.toContain("1000000");
  });

  // Pri tesnom podliezaní hranice (999 999 z 1 000 000) je neformátovaná strana
  // presne tá, ktorá sa predtým nechávala ako holé číslo — "999999" vedľa
  // "1 000 000" je nekonzistentné a ťažšie čitateľné.
  it("formátuje aj skutočnú veľkosť súboru s medzerami, nielen hranicu", () => {
    const judgement = judgeSnapshot(candidate({ byteSize: 999_999 }));
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("999 999");
    expect(judgement.verdict === "rejected" && judgement.reason).not.toContain("999999");
  });
});

describe("judgeSnapshot — previousAccepted: undefined sa nesmie dereferencovať do výnimky", () => {
  // Bežné volanie vždy dodá `null` pri prvom importe. `undefined` nastane len
  // vtedy, keď pole za behu úplne chýba (napr. stratené v JSON round-tripe) —
  // no `SnapshotCandidate.previousAccepted !== undefined` v type systéme, takže
  // treba prejsť cez `unknown`, presne ako pri `columns: null` vyššie.
  it("previousAccepted: undefined sa správa rovnako ako null (prvý import), nevyhodí výnimku", () => {
    const raw = {
      ...candidate({ rowCount: 999 }),
      previousAccepted: undefined,
    } as unknown as SnapshotCandidate;

    expect(() => judgeSnapshot(raw)).not.toThrow();
    const judgement = judgeSnapshot(raw);
    expect(judgement.verdict).toBe("rejected");
    expect(judgement.verdict === "rejected" && judgement.reason).toContain("prvý import");
  });

  it("previousAccepted: undefined s dostatočným počtom riadkov je prijaté — rovnako ako null", () => {
    const raw = {
      ...candidate({ rowCount: 1_000 }),
      previousAccepted: undefined,
    } as unknown as SnapshotCandidate;

    expect(judgeSnapshot(raw)).toEqual({ verdict: "accepted" });
  });
});

// `readonly` je len na úrovni typov (compile-time) — za behu vie ktorýkoľvek
// konzument tie isté objekty zmutovať a zmeniť správanie brány pre celý proces.
describe("konštanty modulu sú zmrazené za behu (nielen na úrovni typov)", () => {
  it("REQUIRED_COLUMNS je Object.freeze", () => {
    expect(Object.isFrozen(REQUIRED_COLUMNS)).toBe(true);
  });

  it("DEFAULT_SNAPSHOT_LIMITS je Object.freeze", () => {
    expect(Object.isFrozen(DEFAULT_SNAPSHOT_LIMITS)).toBe(true);
  });
});
