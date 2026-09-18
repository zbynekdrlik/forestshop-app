// soxland.sk (Shoptet viacvariantová stránka) — veľkostný parameter podľa OBSAHU
// názvu — issue 566 (podticket #555). Generické pravidlo `shoptet-multivariant.ts`
// (issue 558) hľadalo veľkostný `<select>` PRESNOU zhodou názvu „Velikost”/„Veľkosť”.
// soxland.sk pomenúva parameter „Veľkosť PONOŽKY” → normalizované `velkostponozky`
// → PRESNÁ zhoda zlyhá → všetky veľkosti `unknown`. Prístup 1 (design-record):
// `findSizeParam` porovnáva na OBSAH veľkostného výrazu (velikost|veľkosť|velkost|
// size) s negatívnym zoznamom (napr. „Veľkosť balenia” = veľkosť multipacku, nie
// kusu). „Optické zvětšení” (hunting24.cz) veľkostný výraz NEobsahuje → negatívny
// fixture, že cudzí parameter sa nikdy nevezme. Vlastný súbor (eslint max-lines 400).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchSizeLabel, parseSizeAvailability, type SizeAvailability } from "./parse.js";
import { shoptetMultiVariantSizeList } from "./shoptet-multivariant.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

// Reálne HTML fixtures (stiahnuté browser UA, 2026-09-18).
const SOX_TENKE = fixture("soxland-drhunter-tenke-ponozky.html"); // všetkých 5 veľkostí Skladom
const SOX_CELOROCNE = fixture("soxland-drhunter-celorocne-nedostupne.html"); // 2 nedostupné + 3 dostupné
const HUNTING24 = fixture("hunting24-nv007-opticke-zvetseni.html"); // len „Optické zvětšení”

const SOX_TENKE_URL = "https://www.soxland.sk/dr-hunter-tenke-letne-ponozky-zelene/";
const SOX_CELOROCNE_URL = "https://www.soxland.sk/dr-hunter-funkcne-celorocne-termo-ponozky-odlahcene-zelene/";
const HUNTING24_URL = "https://www.hunting24.cz/nv007sp2-940nm-4k/";

const find = (list: readonly SizeAvailability[] | null, size: string): SizeAvailability | undefined =>
  (list ?? []).find((s) => s.sizeLabel === size);
const findS = (list: readonly { sizeLabel: string; availability: string }[], size: string) =>
  list.find((s) => s.sizeLabel === size);

// Syntetická Shoptet viacvariantová stránka s ĽUBOVOĽNÝM názvom veľkostného
// parametra — na overenie samotného `findSizeParam` (obsahová zhoda + negatívny zoznam).
const shoptetPage = (paramName: string, spans: string): string =>
  '<html><body><div class="p-detail">' +
  `<select id="parameter-id-5" data-parameter-id="5" data-parameter-name="${paramName}">` +
  '<option value="" data-choose="true">Zvoľte variant</option>' +
  '<option value="8">38</option><option value="9">39</option></select>' +
  spans +
  "</div></body></html>";
const span = (key: string, color: string, label: string): string =>
  `<span class="parameter-dependent no-display ${key}">` +
  `<span class="availability-label" style="color: ${color}">${label}</span></span>`;

describe("findSizeParam (shoptetMultiVariantSizeList) — issue 566: veľkosť podľa obsahu názvu", () => {
  it("soxland „Veľkosť PONOŽKY” (tenke): všetkých 5 veľkostí sa prečíta ako available", () => {
    const sizes = shoptetMultiVariantSizeList(SOX_TENKE);
    expect(sizes.length).toBe(5);
    for (const label of ["37-38", "39-41", "42-44", "45-47", "48-49"]) {
      expect(findS(sizes, label)?.availability).toBe("available");
    }
  });

  it("soxland „Veľkosť PONOŽKY” (celoročné): živá polarita — 37-38/39-41 unavailable, zvyšok available", () => {
    const sizes = shoptetMultiVariantSizeList(SOX_CELOROCNE);
    expect(findS(sizes, "37-38")?.availability).toBe("unavailable");
    expect(findS(sizes, "39-41")?.availability).toBe("unavailable");
    expect(findS(sizes, "42-44")?.availability).toBe("available");
    expect(findS(sizes, "45-47")?.availability).toBe("available");
    expect(findS(sizes, "48-49")?.availability).toBe("available");
    expect(sizes.length).toBe(5);
  });

  it("hunting24 „Optické zvětšení” (negatívny): cudzí parameter sa NEvezme → prázdny zoznam", () => {
    expect(shoptetMultiVariantSizeList(HUNTING24)).toEqual([]);
  });

  it("presná zhoda „Velikost” naďalej funguje (regresia issue 558)", () => {
    const html = shoptetPage("Velikost", span("5-8", "#009901", "Skladem") + span("5-9", "#cb0000", "Vyprodáno"));
    const sizes = shoptetMultiVariantSizeList(html);
    expect(findS(sizes, "38")?.availability).toBe("available");
    expect(findS(sizes, "39")?.availability).toBe("unavailable");
  });

  it("negatívny zoznam: „Veľkosť balenia” (veľkosť multipacku) sa NEberie ako variantová veľkosť", () => {
    const html = shoptetPage("Veľkosť balenia", span("5-8", "#009901", "Skladom") + span("5-9", "#009901", "Skladom"));
    expect(shoptetMultiVariantSizeList(html)).toEqual([]);
  });
});

describe("parseSizeAvailability — issue 566: soxland.sk zapnutý ako host (živá polarita overená)", () => {
  it("celoročné: end-to-end cez parseSizeAvailability vráti zmiešaný zoznam", () => {
    const sizes = parseSizeAvailability(SOX_CELOROCNE, SOX_CELOROCNE_URL);
    expect(find(sizes, "37-38")?.availability).toBe("unavailable");
    expect(find(sizes, "42-44")?.availability).toBe("available");
    expect(sizes?.length).toBe(5);
  });

  it("tenke: end-to-end všetky Skladom", () => {
    const sizes = parseSizeAvailability(SOX_TENKE, SOX_TENKE_URL);
    expect((sizes ?? []).length).toBe(5);
    expect((sizes ?? []).every((s) => s.availability === "available")).toBe(true);
  });

  it("matchSizeLabel: naša „42-44” → dodávateľova „42-44” available; „37-38” → unavailable", () => {
    const sizes = parseSizeAvailability(SOX_CELOROCNE, SOX_CELOROCNE_URL);
    const labels = (sizes ?? []).map((s) => s.sizeLabel);
    expect(matchSizeLabel("42-44", labels)).toBe("42-44");
    expect(find(sizes, "37-38")?.availability).toBe("unavailable");
  });

  it("hunting24.cz NIE JE registrované ako size host → parseSizeAvailability null", () => {
    expect(parseSizeAvailability(HUNTING24, HUNTING24_URL)).toBeNull();
  });
});
