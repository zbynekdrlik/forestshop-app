import { describe, expect, it } from "vitest";
import { assignUrls, buildIndex, dedup, resolve, STRENGTH_EXACT, STRENGTH_NONE, STRENGTH_SINGLE, STRENGTH_TIEBREAK } from "./url-resolver.js";

describe("resolve — presné/jednoznačné/nejednoznačné/žiadne zhody", () => {
  it("presná zhoda mena so sitemap slugom → EXACT", () => {
    const index = buildIndex(["moor-padded-waistcoat-367", "iny-produkt"]);
    const result = resolve("Moor Padded Waistcoat 367", index);
    expect(result).toEqual({ url: "https://www.forestshop.sk/moor-padded-waistcoat-367/", strength: STRENGTH_EXACT, nameSlug: "moor-padded-waistcoat-367" });
  });

  it("presne jeden token-superset kandidát → SINGLE", () => {
    const index = buildIndex(["bunda-forest-zelena-40"]);
    const result = resolve("Bunda Forest", index);
    expect(result).toEqual({ url: "https://www.forestshop.sk/bunda-forest-zelena-40/", strength: STRENGTH_SINGLE, nameSlug: "bunda-forest" });
  });

  it("žiadny kandidát → NONE, null URL", () => {
    const index = buildIndex(["uplne-iny-produkt"]);
    const result = resolve("Neexistujuci Produkt", index);
    expect(result).toEqual({ url: null, strength: STRENGTH_NONE, nameSlug: "neexistujuci-produkt" });
  });

  it("prázdne meno → NONE bez pádu", () => {
    const index = buildIndex(["cokolvek"]);
    expect(resolve("", index)).toEqual({ url: null, strength: STRENGTH_NONE, nameSlug: "" });
  });

  it("viac kandidátov, JEDNOZNAČNÝ víťaz (menej nevysvetlených tokenov) → TIEBREAK", () => {
    // "Moor Padded 367" a "Moor Padded 393" oba obsahujú tokeny mena
    // "moor"/"padded" — no "moor-padded-367-vesta" má LEN 1 extra token
    // ("vesta") oproti "moor-padded-367-detska-vesta-velka" s 3 extra.
    const index = buildIndex(["moor-padded-367-vesta", "moor-padded-367-detska-vesta-velka"]);
    const result = resolve("Moor Padded 367", index);
    expect(result.strength).toBe(STRENGTH_TIEBREAK);
    expect(result.url).toBe("https://www.forestshop.sk/moor-padded-367-vesta/");
  });

  it("viac kandidátov s ROVNAKÝM počtom extra tokenov → nejednoznačné, null (radšej nič než zlý odkaz)", () => {
    const index = buildIndex(["moor-padded-367-lady", "moor-padded-367-youth"]);
    const result = resolve("Moor Padded 367", index);
    expect(result).toEqual({ url: null, strength: STRENGTH_NONE, nameSlug: "moor-padded-367" });
  });
});

describe("dedup — dve RÔZNE produkty nikdy nezdieľajú jednu URL", () => {
  it("dvaja rôzni kandidáti na tú istú URL — silnejší vyhráva, slabší dostane null", () => {
    const resolved = [
      { url: "https://www.forestshop.sk/x/", strength: STRENGTH_EXACT, nameSlug: "produkt-a" },
      { url: "https://www.forestshop.sk/x/", strength: STRENGTH_SINGLE, nameSlug: "produkt-b" },
    ];
    const out = dedup(resolved);
    expect(out.get(0)).toBe("https://www.forestshop.sk/x/");
    expect(out.get(1)).toBeNull();
  });

  it("rovnaký nameSlug (genuine duplicitný produkt) — OBAJA si URL ponechajú", () => {
    const resolved = [
      { url: "https://www.forestshop.sk/x/", strength: STRENGTH_EXACT, nameSlug: "rovnaky-produkt" },
      { url: "https://www.forestshop.sk/x/", strength: STRENGTH_EXACT, nameSlug: "rovnaky-produkt" },
    ];
    const out = dedup(resolved);
    expect(out.get(0)).toBe("https://www.forestshop.sk/x/");
    expect(out.get(1)).toBe("https://www.forestshop.sk/x/");
  });

  it("remíza medzi DVOMA rôznymi produktmi s rovnakou silou — obaja dostanú null", () => {
    const resolved = [
      { url: "https://www.forestshop.sk/x/", strength: STRENGTH_SINGLE, nameSlug: "produkt-a" },
      { url: "https://www.forestshop.sk/x/", strength: STRENGTH_SINGLE, nameSlug: "produkt-b" },
    ];
    const out = dedup(resolved);
    expect(out.get(0)).toBeNull();
    expect(out.get(1)).toBeNull();
  });

  it("null URL sa nikdy nedostane do byUrl skupiny (žiadny pád na dvoch null zápisoch)", () => {
    const resolved = [
      { url: null, strength: STRENGTH_NONE, nameSlug: "a" },
      { url: null, strength: STRENGTH_NONE, nameSlug: "b" },
    ];
    const out = dedup(resolved);
    expect(out.get(0)).toBeNull();
    expect(out.get(1)).toBeNull();
  });
});

describe("assignUrls — end-to-end nad zoznamom mien", () => {
  it("rieši viacero produktov naraz a dedupuje naprieč nimi", () => {
    const names = ["Bunda Forest", "Neexistujuci Produkt", "Moor Padded Waistcoat 367"];
    const slugs = ["bunda-forest-zelena", "moor-padded-waistcoat-367"];
    const out = assignUrls(names, slugs);
    expect(out.get(0)).toBe("https://www.forestshop.sk/bunda-forest-zelena/");
    expect(out.get(1)).toBeNull();
    expect(out.get(2)).toBe("https://www.forestshop.sk/moor-padded-waistcoat-367/");
  });
});
