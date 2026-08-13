import { describe, expect, it } from "vitest";
import { candidateSlugs, resolveProbe } from "./candidates.js";

// Fixtúrové hodnoty odchytené priamo z nainštalovanej starej appky
// (`parovanie_produktov` @ HEAD, `PYTHONPATH=src:scripts python3 -c "from
// resolve_urls import candidates; print(candidates(...))"`).
describe("candidateSlugs — port resolve_urls.py's candidates()", () => {
  it.each([
    ["Poľovnícke nohavice Forest", ["polovnicke-nohavice-forest", "forest", "polovnicke-polovnicke-nohavice-forest", "polovnicka-polovnicke-nohavice-forest", "polovnicky-polovnicke-nohavice-forest"]],
    ["15 Bunda Forest zelená", ["bunda-forest-zelena", "forest-zelena", "polovnicke-bunda-forest-zelena", "polovnicka-bunda-forest-zelena", "polovnicky-bunda-forest-zelena"]],
    ["Vesta žieňová", ["vesta-zienova", "zienova", "polovnicke-vesta-zienova", "polovnicka-vesta-zienova", "polovnicky-vesta-zienova"]],
    ["Nohavice Strike Deerhunter", ["nohavice-strike-deerhunter", "strike-deerhunter", "polovnicke-nohavice-strike-deerhunter", "polovnicka-nohavice-strike-deerhunter", "polovnicky-nohavice-strike-deerhunter"]],
  ])("candidateSlugs(%j) === %j", (input, expected) => {
    expect(candidateSlugs(input)).toEqual(expected);
  });

  it("meno bez ÚVODNÝCH generických slov nevyrobí duplicitný druhý kandidát (dedup)", () => {
    // "Strike Deerhunter" (bez GEN slova na začiatku) → i zostáva 0, žiadny
    // druhý kandidát sa nepridá.
    expect(candidateSlugs("Strike Deerhunter")).toEqual([
      "strike-deerhunter",
      "polovnicke-strike-deerhunter",
      "polovnicka-strike-deerhunter",
      "polovnicky-strike-deerhunter",
    ]);
  });
});

describe("resolveProbe — HTTP sonda VŠETKÝCH kandidátov (nikdy prvý 200)", () => {
  it("žiadny kandidát nepotvrdený → null", async () => {
    const result = await resolveProbe("Neexistujúci Produkt", () => Promise.resolve(null));
    expect(result).toEqual({ url: null, strength: 0, nameSlug: "neexistujuci-produkt" });
  });

  it("presne jeden kandidát potvrdený → SINGLE", async () => {
    const fetchCandidate = (c: string) => Promise.resolve(c === "bunda-forest" ? "https://www.forestshop.sk/bunda-forest/" : null);
    const result = await resolveProbe("Bunda Forest", fetchCandidate);
    expect(result).toEqual({ url: "https://www.forestshop.sk/bunda-forest/", strength: 2, nameSlug: "bunda-forest" });
  });

  it("sonduje VŠETKÝCH kandidátov, nie len prvého potvrdeného (dôkaz cez volací počítadlo)", async () => {
    let calls = 0;
    const fetchCandidate = () => {
      calls += 1;
      return Promise.resolve(null);
    };
    await resolveProbe("Poľovnícke nohavice Forest", fetchCandidate);
    expect(calls).toBe(5); // presne toľko kandidátov, koľko candidateSlugs() vráti
  });

  it("dva potvrdené kandidáty s ROVNAKÝM počtom extra tokenov → remíza, null (radšej nič než zlý odkaz)", async () => {
    const fetchCandidate = (c: string) =>
      Promise.resolve(
        c === "vesta-zienova" ? "https://www.forestshop.sk/vesta-zienova/" : c === "zienova" ? "https://www.forestshop.sk/zienova/" : null,
      );
    // "vesta-zienova" aj "zienova" majú OBA 0 extra tokenov oproti nameSlugu
    // "vesta-zienova" (obe sú podmnožinou jeho vlastných tokenov) — remíza.
    const result = await resolveProbe("Vesta žieňová", fetchCandidate);
    expect(result.strength).toBe(0);
    expect(result.url).toBeNull();
  });

  it("dva potvrdené kandidáty s JEDNOZNAČNÝM víťazom (menej extra tokenov) → TIEBREAK", async () => {
    // "15 Bunda Forest zelená" → kandidáti ["bunda-forest-zelena",
    // "forest-zelena", "polovnicke-bunda-forest-zelena", ...]. Potvrdíme
    // "forest-zelena" (0 extra tokenov oproti nameSlug "bunda-forest-zelena")
    // a "polovnicke-bunda-forest-zelena" (1 navyše oproti menu — "polovnicke") —
    // jednoznačný víťaz je "forest-zelena".
    const fetchCandidate = (c: string) =>
      Promise.resolve(
        c === "forest-zelena"
          ? "https://www.forestshop.sk/forest-zelena/"
          : c === "polovnicke-bunda-forest-zelena"
            ? "https://www.forestshop.sk/polovnicke-bunda-forest-zelena/"
            : null,
      );
    const result = await resolveProbe("15 Bunda Forest zelená", fetchCandidate);
    // nameSlug = slug(name) BEZ stripLeadingNumber (presne ako stará appky
    // resolve_probe's `ns = slug(name)`) — "15" ostáva súčasťou.
    expect(result).toEqual({ url: "https://www.forestshop.sk/forest-zelena/", strength: 1, nameSlug: "15-bunda-forest-zelena" });
  });
});
