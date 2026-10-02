// huntingshop.eu per-veľkosť pravidlo (issue 585). PROD 2. 10. 2026: restock
// prepol 62780/43 a 62780/44 (Tracker BOA GTX) na „Skladom", hoci ich dodávateľ
// nemá — huntingshop.eu nemal SIZE pravidlo, takže sa zapísal len PLOŠNÝ riadok
// („skladom" za celý produkt) a `restock/queries.ts` cez `size_label=''` vetvu
// spároval VŠETKY naše vypredané veľkosti odkazu.
//
// Stránka nesie DVA výbery veľkostí: formulár „Kúpiť" (len veľkosti skladom) a
// formulár „Strážny pes" (všetky veľkosti). Živé fixtúry (curl, browser UA,
// 2. 10. 2026): 8954 (43/44 chýbajú v Kúpiť), 4796 (jednoveľkostný olej, Kúpiť
// bez výberu), 14708 (úplne vypredané tričko, Kúpiť na stránke vôbec nie je).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSizeStockRows } from "./run.js";
import { hasSizeAvailabilityRule, parsePage, parseSizeAvailability, sizeStructureErrorFor } from "./parse.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const TRACKER_8954 = fixture("huntingshop-velkosti-tracker-boa-8954.html");
const OLEJ_4796 = fixture("huntingshop-jednovelkostny-olej-4796.html");
const TRICKO_14708 = fixture("huntingshop-vypredane-tricko-14708.html");

const SHADE_14093 = fixture("huntingshop-velkosti-shade-h-mikina-14093.html");
const URL_14093 = "https://www.huntingshop.eu/shade-h-hoodie-mikina-pixel-forest-14093";
const URL_8954 ="https://www.huntingshop.eu/tracker-boa-gtx-obuv-military-green-8954";
const URL_4796 = "https://www.huntingshop.eu/olej-na-zbrane-beretta-125-ml-4796";
const URL_14708 = "https://www.huntingshop.eu/500-years-big-silver-camo-tricko-bright-white-14708";

const availabilityOf = (list: readonly { sizeLabel: string; availability: string }[] | null, label: string): string | undefined =>
  list?.find((s) => s.sizeLabel === label)?.availability;

const rowsFor = (html: string, url: string, ourSizes: readonly string[]) =>
  buildSizeStockRows({
    ourSizes,
    sizeList: parseSizeAvailability(html, url),
    hostHasSizeRule: hasSizeAvailabilityRule("huntingshop.eu"),
    page: parsePage(html, url),
  });

describe("huntingshop.eu per-veľkosť — issue 585", () => {
  it("huntingshop.eu má SIZE pravidlo (aj poddoména), cudzia doména s rovnakým koncom nie", () => {
    expect(hasSizeAvailabilityRule("huntingshop.eu")).toBe(true);
    expect(hasSizeAvailabilityRule("shop.huntingshop.eu")).toBe(true);
    expect(hasSizeAvailabilityRule("nothuntingshop.eu")).toBe(false);
  });

  it("8954: veľkosť vo výbere Kúpiť je available, veľkosť len v Strážnom psovi je unavailable", () => {
    const list = parseSizeAvailability(TRACKER_8954, URL_8954);
    expect(availabilityOf(list, "42")).toBe("available");
    expect(availabilityOf(list, "45")).toBe("available");
    expect(availabilityOf(list, "36")).toBe("available");
    expect(availabilityOf(list, "43")).toBe("unavailable");
    expect(availabilityOf(list, "44")).toBe("unavailable");
    expect(list).toHaveLength(12);
  });

  it("8954: riadky pre naše veľkosti — 43/44 unavailable (už sa neprepnú), 42/45 available, cudzia 48 unknown", () => {
    const rows = rowsFor(TRACKER_8954, URL_8954, ["42", "43", "44", "45", "48"]);
    const by = (label: string) => rows.find((r) => r.sizeLabel === label);
    expect(rows.some((r) => r.sizeLabel === "")).toBe(false);
    expect(by("43")?.availability).toBe("unavailable");
    expect(by("44")?.availability).toBe("unavailable");
    expect(by("42")?.availability).toBe("available");
    expect(by("45")?.availability).toBe("available");
    expect(by("48")?.availability).toBe("unknown");
  });

  it("14093 (náš 62794 HART SHADE-H): L len v Strážnom psovi → unavailable, M v Kúpiť → available", () => {
    const rows = rowsFor(SHADE_14093, URL_14093, ["M", "L"]);
    expect(rows.map((r) => [r.sizeLabel, r.availability])).toEqual([
      ["M", "available"],
      ["L", "unavailable"],
    ]);
  });

  it("4796: jednoveľkostný produkt (Kúpiť bez výberu) → null → plošný riadok ako doteraz", () => {
    expect(parseSizeAvailability(OLEJ_4796, URL_4796)).toBeNull();
    const rows = rowsFor(OLEJ_4796, URL_4796, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sizeLabel).toBe("");
    expect(rows[0]?.availability).toBe("available");
  });

  it("14708: formulár Kúpiť chýba, Strážny pes nesie veľkosti → všetky unavailable", () => {
    const list = parseSizeAvailability(TRICKO_14708, URL_14708);
    expect(list?.map((s) => s.sizeLabel)).toEqual(["S", "M", "L", "XL", "2XL", "3XL", "4XL"]);
    expect(list?.every((s) => s.availability === "unavailable")).toBe(true);
    const rows = rowsFor(TRICKO_14708, URL_14708, ["M", "XL"]);
    expect(rows.map((r) => [r.sizeLabel, r.availability])).toEqual([
      ["M", "unavailable"],
      ["XL", "unavailable"],
    ]);
  });

  it("nejednoznačná stránka → null (fail-closed): dva výbery Kúpiť", () => {
    const cart = TRACKER_8954.match(/<select\b[^>]*name="variant_id"[\s\S]*?<\/select>/)?.[0] ?? "";
    expect(cart).not.toBe("");
    const html = TRACKER_8954.replace(cart, `${cart}${cart}`);
    expect(parseSizeAvailability(html, URL_8954)).toBeNull();
    expect(sizeStructureErrorFor(html, URL_8954)).toMatch(/nejednoznačná/);
  });

  it("nejednoznačná stránka → null (fail-closed): veľkosť v Kúpiť, ktorú Strážny pes nepozná", () => {
    const html = TRACKER_8954.replace('<option value="25693">46</option><option value="25694">47</option>                    </select>', '<option value="25693">46</option><option value="25694">47</option><option value="99999">49</option></select>');
    expect(html).not.toBe(TRACKER_8954);
    expect(parseSizeAvailability(html, URL_8954)).toBeNull();
    expect(sizeStructureErrorFor(html, URL_8954)).toMatch(/49/);
  });

  it("zmenená štruktúra: formulár Kúpiť bez výberu veľkosti, Strážny pes veľkosti má → chyba, nikdy available", () => {
    const html = TRACKER_8954.replace('id="frm-addToCart-form-variant_id"', 'id="frm-addToCart-form-variant"');
    expect(html).not.toBe(TRACKER_8954);
    expect(parseSizeAvailability(html, URL_8954)).toBeNull();
    expect(sizeStructureErrorFor(html, URL_8954)).toMatch(/bez výberu veľkosti/);
  });

  it("čitateľné stránky nemajú štruktúrnu chybu; doména bez pravidla tiež nie", () => {
    expect(sizeStructureErrorFor(TRACKER_8954, URL_8954)).toBeNull();
    expect(sizeStructureErrorFor(OLEJ_4796, URL_4796)).toBeNull();
    expect(sizeStructureErrorFor(TRICKO_14708, URL_14708)).toBeNull();
    expect(sizeStructureErrorFor(SHADE_14093, URL_14093)).toBeNull();
    expect(sizeStructureErrorFor(TRACKER_8954, "https://odimon.sk/p/1")).toBeNull();
  });

  it("8954 cez buildSizeStockRows bez nášho výberu (výber chýba) nikdy nezapíše plošný available pre viac veľkostí", () => {
    const withoutSelects = TRACKER_8954.replace(/<select\b[\s\S]*?<\/select>/g, "");
    const rows = rowsFor(withoutSelects, URL_8954, ["43", "44"]);
    expect(rows.map((r) => [r.sizeLabel, r.availability])).toEqual([
      ["43", "unknown"],
      ["44", "unknown"],
    ]);
  });

  // Code review issue 585 — zvyšné cesty k plošnému „skladom".
  // Reálny inline JS z živej stránky (je na KAŽDEJ huntingshop stránke, aj jednoveľkostnej).
  const INLINE_JS =
    '<script>var $variantSel = document.getElementById("frm-addToCart-form-variant_id");' +
    " const variantSelect = document.querySelector('select[name=\"variant_id\"]');</script>";

  it("id formulára Kúpiť v inline JS sa neráta ako výber (jednoveľkostný ostáva plošný, 8954 nie je nejednoznačné)", () => {
    expect(parseSizeAvailability(OLEJ_4796 + INLINE_JS, URL_4796)).toBeNull();
    expect(sizeStructureErrorFor(OLEJ_4796 + INLINE_JS, URL_4796)).toBeNull();
    expect(parseSizeAvailability(TRACKER_8954 + INLINE_JS, URL_8954)).toHaveLength(12);
    expect(sizeStructureErrorFor(TRACKER_8954 + INLINE_JS, URL_8954)).toBeNull();
  });

  it("premenované id OBOCH výberov (výbery podľa name stále na stránke) → chyba, nikdy plošné available pre jednu našu veľkosť", () => {
    const html = TRACKER_8954.replace('id="frm-addToCart-form-variant_id"', 'id="novy-kosik"').replace(
      'id="frm-watchDogForm-form-variantIds"',
      'id="novy-pes"',
    );
    expect(parseSizeAvailability(html, URL_8954)).toBeNull();
    expect(sizeStructureErrorFor(html, URL_8954)).toMatch(/zmenená štruktúra/);
  });

  it("stránka so zoznamom ≥2 veľkostí, ale bez NAŠICH veľkostí → plošný unknown, nikdy štítok pri cene", () => {
    const rows = rowsFor(TRACKER_8954, URL_8954, []);
    expect(rows).toEqual([{ sizeLabel: "", availability: "unknown", availabilityText: "", price: null, source: "none" }]);
  });
});

