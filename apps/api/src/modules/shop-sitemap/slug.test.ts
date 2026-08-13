import { describe, expect, it } from "vitest";
import { slug, tokens } from "./slug.js";

// Fixtúrové hodnoty odchytené priamo z nainštalovanej starej appky
// (`parovanie_produktov` @ HEAD, `python3 -c "from src.parovanie.
// export_helpers import slug; print(slug(...))"`) — rovnaký disciplína ako
// `.claude/rules/pairing-search.md`'s `token-set-ratio.test.ts` (fixtúrové
// testy proti reálnym referenčným hodnotám, nie len proti vlastnej intuícii).
describe("slug — port parovanie_produktov's export_helpers.slug()", () => {
  it.each([
    ["Strike Nohavice DEERHUNTER 3989-388", "strike-nohavice-deerhunter-3989-388"],
    ["Moor Padded Waistcoat 367", "moor-padded-waistcoat-367"],
    ["1003 Bunda FOREST", "1003-bunda-forest"],
    ["100 Bunda FOREST", "100-bunda-forest"],
    ["Pončo Deerhunter Survivor", "ponco-deerhunter-survivor"],
    ["Vesta žieňová č.5 (žltá)", "vesta-zienova-c-5-zlta"],
    ['Rukavice "Zimné" — teplé', "rukavice-zimne-teple"],
    ["  Medzery   naokolo  ", "medzery-naokolo"],
    ["Čižmy poľovnícke NEOPRÉN 40/41", "cizmy-polovnicke-neopren-40-41"],
    ["", ""],
  ])("slug(%j) === %j", (input, expected) => {
    expect(slug(input)).toBe(expected);
  });

  it("stripLeadingNumber odreže VEDÚCI index bez ohľadu na počet číslic (na rozdiel od normalize.ts's clean_name)", () => {
    expect(slug("1003 Bunda FOREST", true)).toBe("bunda-forest");
    expect(slug("100 Bunda FOREST", true)).toBe("bunda-forest");
    expect(slug("Strike Nohavice DEERHUNTER 3989-388", true)).toBe("strike-nohavice-deerhunter-3989-388");
  });
});

describe("tokens — meaningful slug tokens (drop pure-digit and single-char fragments)", () => {
  it("odstráni čisto číselné a jednoznakové fragmenty", () => {
    expect(tokens("strike-nohavice-deerhunter-3989-388")).toEqual(new Set(["strike", "nohavice", "deerhunter"]));
  });

  it("prázdny slug dá prázdnu množinu", () => {
    expect(tokens("")).toEqual(new Set());
  });

  it("jednopísmenové/dvojpísmenové tokeny — presne length > 1 hranica", () => {
    expect(tokens("a-bb-ccc")).toEqual(new Set(["bb", "ccc"]));
  });
});
