// wetland.sk (PrestaShop 1.7/8) fáza 2 — enumerácia VŠETKÝCH veľkostí, issue 552.
// Fáza 1 (549/551) čítala len JEDNU kombináciu z prípony odkazu; ostatné naše
// veľkosti toho odkazu ostávali `unknown`. Fáza 2 (Prístup 1): z bázovej
// stránky sa vyčíta `id_product` + `<select name="group[N]">`, pre KAŽDÚ
// veľkosť sa poskladá `action=refresh` GET URL, odpoveď sa rozbalí
// (`product_details` z JSON) a pošle do existujúceho `readWetlandCombination`/
// `wetlandSizeList` (znovupoužitie, bez forku). Výsledky sa zlúčia
// (`mergeSizeAvailability`). Vlastný súbor (rovnaký dôvod ako
// parse-issue307/330/332/549/551 — eslint max-lines 400).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { wetlandEnumerateCombinations, wetlandSuffixMismatch } from "./availability-domain-rules.js";
import { mergeSizeAvailability, parseCombinationResponse, sizeCombinationEnumeratorFor } from "./parse.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const BASE = fixture("wetland-enum-eagle-bunda-369-2398.html");
const REFRESH_48 = fixture("wetland-enum-refresh-369-48.json");
const REFRESH_52 = fixture("wetland-enum-refresh-369-52.json");
const REFRESH_60 = fixture("wetland-enum-refresh-369-60.json");
const BALLISTOL = fixture("wetland-skladom-ballistol-olej-4478.html");

const LINK = "https://www.wetland.sk/bundy/deerhunter-eagle-jacket-polovnicka-bunda-369-2398";
const LINK_STALE = "https://www.wetland.sk/bundy/deerhunter-eagle-jacket-polovnicka-bunda-369-9999";
const BALLISTOL_URL = "https://www.wetland.sk/doplnky/ballistol-universal-oil-035l-olej-na-cistenie-4478";

const refreshUrl = (idAttribute: string): string =>
  `${LINK}?ajax=1&action=refresh&id_product=369&group[1]=${idAttribute}&quantity_wanted=1`;

describe("wetlandEnumerateCombinations — issue 552: URL per veľkosť zo <select name=group[1]>", () => {
  it("z bázovej stránky 369 vyrobí refresh URL pre VŠETKÝCH 9 veľkostí (id_product + id_attribute)", () => {
    const targets = wetlandEnumerateCombinations(BASE, LINK);
    // Poradie ako v <select>: 50,52,54,48,56,58,60,62,64 (id_attribute 10,30,31,9,32,33,13,34,35).
    expect(targets).toEqual([
      { url: refreshUrl("10"), label: "50" },
      { url: refreshUrl("30"), label: "52" },
      { url: refreshUrl("31"), label: "54" },
      { url: refreshUrl("9"), label: "48" },
      { url: refreshUrl("32"), label: "56" },
      { url: refreshUrl("33"), label: "58" },
      { url: refreshUrl("13"), label: "60" },
      { url: refreshUrl("34"), label: "62" },
      { url: refreshUrl("35"), label: "64" },
    ]);
  });

  it("produkt BEZ veľkostí (olej 4478 — žiadny <select>) → prázdny zoznam (enumerácia sa preskočí)", () => {
    expect(wetlandEnumerateCombinations(BALLISTOL, BALLISTOL_URL)).toEqual([]);
  });

  it("prípona s query stringom sa odstráni pred zložením refresh URL", () => {
    const withQuery = `${LINK}?foo=bar`;
    const targets = wetlandEnumerateCombinations(BASE, withQuery);
    expect(targets[0]?.url).toBe(refreshUrl("10"));
  });
});

describe("parseCombinationResponse — issue 552: rozbalí action=refresh JSON a prečíta veľkosť+quantity", () => {
  it("refresh 52 (quantity 1) → available; bez JSON-LD v odpovedi je quantity primárny", () => {
    expect(parseCombinationResponse(REFRESH_52, LINK)).toEqual([{ sizeLabel: "52", availability: "available" }]);
  });

  it("refresh 60 (quantity 1) → available", () => {
    expect(parseCombinationResponse(REFRESH_60, LINK)).toEqual([{ sizeLabel: "60", availability: "available" }]);
  });

  it("refresh 48 (quantity 0, allow_oosp — 'Centrálny sklad') → unavailable (nikdy sa nečíta pole availability)", () => {
    expect(parseCombinationResponse(REFRESH_48, LINK)).toEqual([{ sizeLabel: "48", availability: "unavailable" }]);
  });

  it("nevalidný JSON odpovede → prázdno (fail-closed, nikdy pád behu)", () => {
    expect(parseCombinationResponse("neni json", LINK)).toEqual([]);
  });

  it("iná doména bez enumeračného pravidla → prázdno", () => {
    expect(parseCombinationResponse(REFRESH_52, "https://www.huntingshop.eu/p/1")).toEqual([]);
  });
});

describe("mergeSizeAvailability — issue 552: zlúči zoznamy, dedup podľa názvu, rozpor zahodí", () => {
  it("zlúči viac zoznamov do jedného", () => {
    const merged = mergeSizeAvailability(
      [{ sizeLabel: "48", availability: "unavailable" }],
      [{ sizeLabel: "52", availability: "available" }],
      [{ sizeLabel: "60", availability: "available" }],
    );
    expect([...merged].sort((a, b) => a.sizeLabel.localeCompare(b.sizeLabel))).toEqual([
      { sizeLabel: "48", availability: "unavailable" },
      { sizeLabel: "52", availability: "available" },
      { sizeLabel: "60", availability: "available" },
    ]);
  });

  it("rovnaká veľkosť s ROVNAKOU dostupnosťou (base + enumerácia default) → jedna položka", () => {
    const merged = mergeSizeAvailability(
      [{ sizeLabel: "48", availability: "unavailable" }],
      [{ sizeLabel: "48", availability: "unavailable" }],
    );
    expect(merged).toEqual([{ sizeLabel: "48", availability: "unavailable" }]);
  });

  it("rovnaká veľkosť s ROZPORNOU dostupnosťou → veľkosť sa ZAHODÍ (fail-closed, nikdy dohad)", () => {
    const merged = mergeSizeAvailability(
      [{ sizeLabel: "48", availability: "available" }],
      [{ sizeLabel: "48", availability: "unavailable" }],
    );
    expect(merged).toEqual([]);
  });
});

describe("wetlandSuffixMismatch — issue 552: zastaraná prípona (301 redirect na predvolenú kombináciu)", () => {
  it("prípona -369-9999 ≠ načítaná kombinácia (ipa 2398) → nesúlad na logovanie", () => {
    expect(wetlandSuffixMismatch(BASE, LINK_STALE)).toEqual({ expected: "9999", actual: "2398" });
  });

  it("prípona -369-2398 = načítaná kombinácia → žiadny nesúlad (null)", () => {
    expect(wetlandSuffixMismatch(BASE, LINK)).toBeNull();
  });
});

describe("sizeCombinationEnumeratorFor — issue 552: len wetland má enumeráciu", () => {
  it("wetland.sk → enumerátor prítomný", () => {
    expect(sizeCombinationEnumeratorFor(LINK)).not.toBeNull();
  });

  it("shop.lasting.eu (size-rule bez enumerácie) → null", () => {
    expect(sizeCombinationEnumeratorFor("https://shop.lasting.eu/bony-cepica")).toBeNull();
  });

  it("doména bez size-rule (huntingshop.eu) → null", () => {
    expect(sizeCombinationEnumeratorFor("https://www.huntingshop.eu/p/1")).toBeNull();
  });
});
