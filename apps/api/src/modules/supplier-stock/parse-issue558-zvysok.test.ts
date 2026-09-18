// luko.cz zvyšok (issue 558, podticket #555) — dve chyby, ktoré nechávali
// 192 + 9 variantov `unknown` aj po prvom lane:
//   (A) `matchSizeLabel` odmietne PÁROVÝ náš štítok („39-40", „47/48", „51/52")
//       proti JEDNOTLIVÝM číslam dodávateľa („38",„39",…) — luko predáva košele
//       po jednom čísle goliera. `foldMultiTokenSizeAvailability` rozloží náš
//       štítok na tokeny, každý vyhľadá v zozname a ZLOŽÍ (fail-closed).
//   (B) jednovariantová „Velikost" stránka → `parseSizeAvailability` null →
//       plošný `''` riadok prekryl VŠETKY naše veľkosti. `buildSizeStockRows`
//       na doméne so SIZE pravidlom, keď držíme >1 veľkosť, zapíše per-veľkosť
//       `unknown` NAMIESTO plošného riadku (rovnaký over-match, aký issue 551
//       rieši pre wetland).
// Živé fixtúry (HTTP 200, 2026-09-19, browser UA): model-122212 (A),
// model-162214 (B). Vlastný súbor (eslint max-lines 400).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSizeStockRows } from "./run.js";
import { foldMultiTokenSizeAvailability, parsePage, parseSizeAvailability, type SizeAvailability } from "./parse.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const LUKO_122212 = fixture("luko-viacvelkostna-122212.html");
const URL_122212 = "https://www.luko.cz/kosile-s-dlouhym-rukavem-2/panska-flanelova-kosile-model-122212/";

// Dodávateľ predáva jednotlivé čísla, my držíme párové štítky.
const OUR_122212 = ["38", "39-40", "41-42", "47-48", "49-50", "51-52", "55-56"] as const;

const row = <T extends { readonly sizeLabel: string }>(rows: readonly T[], label: string): T | undefined =>
  rows.find((r) => r.sizeLabel === label);

describe("foldMultiTokenSizeAvailability — issue 558 (A): rozklad párového štítku", () => {
  const list: readonly SizeAvailability[] = [
    { sizeLabel: "39", availability: "available" },
    { sizeLabel: "40", availability: "available" },
    { sizeLabel: "47", availability: "unavailable" },
    { sizeLabel: "48", availability: "available" },
    { sizeLabel: "51", availability: "unavailable" },
    { sizeLabel: "52", availability: "unavailable" },
  ];

  it("všetky tokeny available → available", () => {
    expect(foldMultiTokenSizeAvailability("39-40", list)?.availability).toBe("available");
  });

  it("všetky tokeny unavailable → unavailable", () => {
    expect(foldMultiTokenSizeAvailability("51/52", list)?.availability).toBe("unavailable");
  });

  it("zmiešané (47 unavailable + 48 available) → unknown (fail-closed)", () => {
    expect(foldMultiTokenSizeAvailability("47-48", list)?.availability).toBe("unknown");
  });

  it("chýbajúci token (41 nie je v zozname) → unknown (fail-closed)", () => {
    expect(foldMultiTokenSizeAvailability("40-41", list)?.availability).toBe("unknown");
  });

  it("jednotokenový štítok → null (rieši ho matchSizeLabel, nie fold)", () => {
    expect(foldMultiTokenSizeAvailability("39", list)).toBeNull();
  });
});

describe("buildSizeStockRows — issue 558 (A): live fixtúra model-122212", () => {
  it("dodávateľ predáva jednotlivé čísla 38..54, všetky Skladem", () => {
    const sizes = parseSizeAvailability(LUKO_122212, URL_122212);
    expect(row(sizes ?? [], "38")?.availability).toBe("available");
    expect(row(sizes ?? [], "54")?.availability).toBe("available");
    expect((sizes ?? []).length).toBe(14);
  });

  it("párové štítky sa zložia; chýbajúce (50,51,53,55,56) → unknown, žiadny plošný riadok", () => {
    const sizeList = parseSizeAvailability(LUKO_122212, URL_122212);
    const page = parsePage(LUKO_122212, URL_122212);
    const rows = buildSizeStockRows({ ourSizes: [...OUR_122212], sizeList, hostHasSizeRule: true, page });

    expect(row(rows, "38")?.availability).toBe("available"); // priama zhoda
    expect(row(rows, "38")?.source).toBe("size_list");
    expect(row(rows, "39-40")?.availability).toBe("available"); // fold
    expect(row(rows, "39-40")?.source).toBe("size_list");
    expect(row(rows, "41-42")?.availability).toBe("available");
    expect(row(rows, "47-48")?.availability).toBe("available");
    expect(row(rows, "49-50")?.availability).toBe("unknown"); // 50 chýba
    expect(row(rows, "49-50")?.source).toBe("none");
    expect(row(rows, "51-52")?.availability).toBe("unknown"); // 51 chýba
    expect(row(rows, "55-56")?.availability).toBe("unknown"); // oba chýbajú

    expect(rows.length).toBe(OUR_122212.length);
    expect(rows.some((r) => r.sizeLabel === "")).toBe(false);
  });
});

const HALENKA_162214 = fixture("luko-skladem-halenka-162214.html");
const URL_162214 = "https://www.luko.cz/halenky-s-dlouhym-rukavem/damska-halenka-s-dlouhym-rukavem-model-162214/";
// Halenka má 9 veľkostí (34–50), stránka len JEDNU možnosť „Velikost".
const OUR_162214 = ["34", "36", "38", "40", "42", "44", "46", "48", "50"] as const;

describe("buildSizeStockRows — issue 558 (B): jediná možnosť → per-veľkosť unknown, nie plošný", () => {
  it("model-162214: jedna možnosť Velikost → parseSizeAvailability null, parsePage available/text", () => {
    expect(parseSizeAvailability(HALENKA_162214, URL_162214)).toBeNull();
    const page = parsePage(HALENKA_162214, URL_162214);
    expect(page.availability).toBe("available");
    expect(page.source).toBe("text");
  });

  it("host so SIZE pravidlom + null zoznam + >1 veľkosť → per-veľkosť unknown, ŽIADNY plošný riadok", () => {
    const page = parsePage(HALENKA_162214, URL_162214);
    const rows = buildSizeStockRows({ ourSizes: [...OUR_162214], sizeList: null, hostHasSizeRule: true, page });
    expect(rows.length).toBe(OUR_162214.length);
    expect(rows.every((r) => r.availability === "unknown")).toBe(true);
    expect(rows.every((r) => r.source === "none")).toBe(true);
    expect(rows.some((r) => r.sizeLabel === "")).toBe(false);
  });

  it("host BEZ SIZE pravidla + null zoznam → plošný riadok (nezmenené, Ballistol)", () => {
    const page = parsePage(HALENKA_162214, URL_162214);
    const rows = buildSizeStockRows({ ourSizes: [...OUR_162214], sizeList: null, hostHasSizeRule: false, page });
    expect(rows).toEqual([
      { sizeLabel: "", availability: page.availability, availabilityText: page.availabilityText, price: page.price, source: page.source },
    ]);
  });

  it("host so SIZE pravidlom ale len 1 naša veľkosť → plošný riadok (dizajn: len pri >1)", () => {
    const page = parsePage(HALENKA_162214, URL_162214);
    const rows = buildSizeStockRows({ ourSizes: ["50"], sizeList: null, hostHasSizeRule: true, page });
    expect(rows.length).toBe(1);
    expect(rows[0]?.sizeLabel).toBe("");
  });
});
