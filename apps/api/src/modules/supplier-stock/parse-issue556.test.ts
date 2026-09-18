// tthunt.sk (PrestaShop 1.7/8) pravidlo dostupnosti — issue 556 (podticket #555).
// Rovnaký tvar ako wetland.sk: detailový blok nesie JSON s `quantity` + `attributes`
// v atribúte, JSON-LD `offers.availability` je krížová kontrola, pole `availability`
// je KONŠTANTNE "available" (allow_oosp 1) — nikdy sa nečíta, rozhoduje quantity.
// Preto tthunt znovupoužíva `wetlandVisibleAvailability` (VISIBLE, blanket cesta) aj
// `wetlandSizeList` + wetland enumerátor (SIZE + action=refresh) — naživo overené
// 2026-09-18, že `action=refresh` GET funguje aj na tthunt. Vlastný súbor (rovnaký
// dôvod ako parse-issue549/551/552 — eslint max-lines 400).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { visibleAvailabilityFor } from "./availability-domain-rules.js";
import {
  parseCombinationResponse,
  parsePage,
  parseSizeAvailability,
  sizeCombinationEnumeratorFor,
} from "./parse.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const PETER = fixture("tthunt-skladom-peter-classic-3058-956.html");
const REFRESH_S = fixture("tthunt-refresh-956-27.json");
const REFRESH_XXL = fixture("tthunt-refresh-956-31.json");
const PUZDRO = fixture("tthunt-skladom-puzdro-1388.html");
// issue 556 (zvyšok): reálna tthunt stránka, kde je veľkostná skupina pomenovaná
// „Konfekčná veľkosť" (normalizované `konfekcnavelkost`) namiesto „Veľkosť" —
// starý `isWetlandSizeGroup` (`startsWith("velkost")`) ju NEROZPOZNAL → per-veľkosť
// čítač vrátil prázdno a beh zapísal N riadkov `unknown|none`. Stiahnuté browser UA
// 2026-09-18, HTTP 200, UTF-8: quantity 20 / JSON-LD InStock, veľkosť „46".
const RIDGE = fixture("tthunt-konfekcna-ridge-pro-4104-1322.html");

const PETER_URL = "https://www.tthunt.sk/kosele/swedteam-kosela-peter-classic-3058-956.html";
const PUZDRO_URL = "https://www.tthunt.sk/ruksaky-ladvinky-tasky-penazenky/puzdro-na-dalekohlad-1388.html";
const RIDGE_URL = "https://www.tthunt.sk/muzi/ridge-pro-desolve-veil-4104-1322.html";

const refreshUrl = (idAttribute: string): string =>
  `${PETER_URL}?ajax=1&action=refresh&id_product=956&group[4]=${idAttribute}&quantity_wanted=1`;

describe("parseSizeAvailability — issue 556: tthunt.sk vráti kombináciu z prípony (veľkosť z attributes)", () => {
  it("peter classic 3058-956 → predvolená veľkosť L (quantity 10, JSON-LD InStock) available", () => {
    expect(parseSizeAvailability(PETER, PETER_URL)).toEqual([{ sizeLabel: "L", availability: "available" }]);
  });

  it("jednoveľkostný produkt (puzdro 1388, bez attributes) → null (padne na blanket cez parsePage)", () => {
    expect(parseSizeAvailability(PUZDRO, PUZDRO_URL)).toBeNull();
  });

  it("skupina „Konfekčná veľkosť” (ridge pro 4104-1322) → veľkosť 46 available (obsahová zhoda názvu)", () => {
    // issue 556 (zvyšok): normalizovaný názov skupiny `konfekcnavelkost` OBSAHUJE
    // `velkost`, ale nezačína ním — po zjednotení slovníka veľkostného parametra
    // (`isSizeParamName`) sa rozpozná rovnako ako na Shoptet strane (issue 566).
    expect(parseSizeAvailability(RIDGE, RIDGE_URL)).toEqual([{ sizeLabel: "46", availability: "available" }]);
  });
});

describe("sizeCombinationEnumeratorFor + enumerácia — issue 556: tthunt dostal wetland enumerátor", () => {
  it("tthunt.sk má enumerátor (action=refresh)", () => {
    expect(sizeCombinationEnumeratorFor(PETER_URL)).not.toBeNull();
  });

  it("z bázovej stránky vyrobí refresh URL pre všetkých 6 veľkostí zo select name=group[4]", () => {
    const enumerator = sizeCombinationEnumeratorFor(PETER_URL);
    expect(enumerator).not.toBeNull();
    const targets = enumerator?.targets(PETER, PETER_URL) ?? [];
    expect(targets).toEqual([
      { url: refreshUrl("27"), label: "S" },
      { url: refreshUrl("28"), label: "M" },
      { url: refreshUrl("33"), label: "L" },
      { url: refreshUrl("30"), label: "XL" },
      { url: refreshUrl("31"), label: "XXL" },
      { url: refreshUrl("32"), label: "XXXL" },
    ]);
  });
});

describe("parseCombinationResponse — issue 556: action=refresh JSON, quantity je primárny (allow_oosp pasca)", () => {
  it("refresh S (27, quantity 10) → available", () => {
    expect(parseCombinationResponse(REFRESH_S, PETER_URL)).toEqual([{ sizeLabel: "S", availability: "available" }]);
  });

  it("refresh XXL (31, quantity 0, pole availability STÁLE 'available' – allow_oosp) → unavailable", () => {
    // Dôkaz, že sa NIKDY nečíta konštantné pole `availability`:"available" — rozhoduje quantity 0.
    expect(parseCombinationResponse(REFRESH_XXL, PETER_URL)).toEqual([{ sizeLabel: "XXL", availability: "unavailable" }]);
  });
});

describe("parsePage / visibleAvailabilityFor — issue 556: tthunt blanket cesta (jednoveľkostný)", () => {
  it("puzdro 1388 (bez veľkostí) → available, source text (blanket cez VISIBLE pravidlo)", () => {
    const result = parsePage(PUZDRO, PUZDRO_URL);
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
    expect(result.availabilityText).toBe("Skladom");
  });

  it("visibleAvailabilityFor číta quantity + availability_message priamo (peter → available)", () => {
    expect(visibleAvailabilityFor(PETER_URL, PETER)).toEqual({ availability: "available", text: "Skladom" });
  });
});
