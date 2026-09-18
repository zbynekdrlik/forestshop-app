// luko.cz (Shoptet viacvariantová stránka) per-veľkosť pravidlo — issue 558 (podticket #555).
// Generické Shoptet viacvariantové pravidlo (`shoptet-multivariant.ts`): select
// `data-parameter-name="Velikost|Veľkosť"` (paramId P) → `span.parameter-dependent`
// s kľúčom obsahujúcim pár `P-<valueId>` (koncový pár pri viacerých parametroch) →
// dostupnosť z availability-label + numberAvailabilityAmount. LABEL má prednosť
// (Vyprodáno → unavailable AJ keď „(N ks)" ukazuje kladné číslo — živý nález 2026-09-18,
// produkt 102131 veľkosť 47). Jednovariantová stránka ostáva na `shoptetLabelAvailability`
// (TEXT rule). zubicek.cz zámerne NEregistrované (žiadny živý vypredaný protipól — viď
// report/playbook). Vlastný súbor (eslint max-lines 400).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchSizeLabel, parsePage, parseSizeAvailability, type SizeAvailability } from "./parse.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const LUKO_102131 = fixture("luko-viacvelkostna-102131.html");
const LUKO_242206 = fixture("luko-multiparam-242206.html");
const HALENKA = fixture("luko-skladem-halenka.html");

const URL_102131 = "https://www.luko.cz/myslivecke-a-outdoorove-kosile/panska-kosile-ze-100--bavlny-model-102131/";
const URL_242206 = "https://www.luko.cz/myslivecke-a-outdoorove-kosile/panska-kosile-model-242206/";
const HALENKA_URL = "https://www.luko.cz/damske-halenky-a-kosile/damska-halenka-model-104128/";

const find = (list: readonly SizeAvailability[] | null, size: string): SizeAvailability | undefined =>
  (list ?? []).find((s) => s.sizeLabel === size);

// Inline Shoptet viacvariantová stránka (syntetické edge-case testy — dedup farieb).
const shoptetPage = (spans: string): string =>
  '<html><body><div class="p-detail">' +
  '<select id="parameter-id-5" data-parameter-id="5" data-parameter-name="Velikost">' +
  '<option value="" data-choose="true">Zvolte variantu</option>' +
  '<option value="8">38</option><option value="9">39</option></select>' +
  spans +
  "</div></body></html>";
const span = (key: string, color: string, label: string, amount: string | null): string =>
  `<span class="parameter-dependent no-display ${key}">` +
  `<span class="availability-label" style="color: ${color}">${label}</span>` +
  (amount === null ? "" : `<span class="availability-amount" data-testid="numberAvailabilityAmount">(${amount}&nbsp;ks)</span>`) +
  "</span>";

describe("parseSizeAvailability — issue 558: luko.cz viacvariant per-veľkosť", () => {
  it("102131: veľkosti Skladem → available, veľkosť 47 (Vyprodáno) → unavailable", () => {
    const sizes = parseSizeAvailability(LUKO_102131, URL_102131);
    expect(find(sizes, "38")?.availability).toBe("available");
    expect(find(sizes, "48")?.availability).toBe("available");
    expect(find(sizes, "54")?.availability).toBe("available");
    expect(find(sizes, "47")?.availability).toBe("unavailable");
    expect(sizes?.length).toBe(12);
  });

  it("102131: veľkosť 47 je Vyprodáno so '(3 ks)' — LABEL má prednosť pred číslom (živý nález)", () => {
    // Kľúčový test: numberAvailabilityAmount ukazuje (3 ks), ale label Vyprodáno →
    // unavailable. Číslo kusov NIE JE spoľahlivé, rozhoduje label ako hard-negative.
    expect(find(parseSizeAvailability(LUKO_102131, URL_102131), "47")?.availability).toBe("unavailable");
  });

  it("242206 (viac parametrov, kľúč 22-181-4-3-5-<v>): koncový pár veľkosti (5-<v>) sa spáruje", () => {
    const sizes = parseSizeAvailability(LUKO_242206, URL_242206);
    expect(find(sizes, "45")?.availability).toBe("available");
    expect(find(sizes, "38")?.availability).toBe("available");
    expect((sizes ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it("matchSizeLabel: naša '47' → dodávateľova '47' unavailable; '38' → available", () => {
    const sizes = parseSizeAvailability(LUKO_102131, URL_102131);
    const labels = (sizes ?? []).map((s) => s.sizeLabel);
    expect(matchSizeLabel("47", labels)).toBe("47");
    expect(find(sizes, matchSizeLabel("47", labels) ?? "")?.availability).toBe("unavailable");
  });

  it("tá istá veľkosť v dvoch farbách, OBE Skladem → jedna položka (dedup)", () => {
    const html = shoptetPage(span("4-1-5-8", "#009901", "Skladem", "5") + span("4-3-5-8", "#009901", "Skladem", "2"));
    expect(parseSizeAvailability(html, URL_102131)).toEqual([{ sizeLabel: "38", availability: "available" }]);
  });

  it("tá istá veľkosť v dvoch farbách, ROZPOR (Skladem vs Vyprodáno) → ZAHODÍ (fail-closed)", () => {
    const html = shoptetPage(span("4-1-5-8", "#009901", "Skladem", "5") + span("4-3-5-8", "#cb0000", "Vyprodáno", "0"));
    expect(parseSizeAvailability(html, URL_102131)).toBeNull();
  });

  it("zubicek.cz NIE JE registrované (žiadny živý vypredaný protipól) → null aj na luko markupe", () => {
    expect(parseSizeAvailability(LUKO_102131, "https://www.zubicek.cz/panska-kosile/")).toBeNull();
  });
});

describe("parsePage — issue 558: jednovariantová stránka ostáva na TEXT pravidle (regresia)", () => {
  it("halenka (jednovariant, data-testid=labelAvailability) → parseSizeAvailability null", () => {
    expect(parseSizeAvailability(HALENKA, HALENKA_URL)).toBeNull();
  });

  it("halenka → parsePage available, source text (shoptetLabelAvailability nezmenené)", () => {
    const result = parsePage(HALENKA, HALENKA_URL);
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
  });
});
