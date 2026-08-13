import { expect, it } from "vitest";
import { JOB_LABELS, jobLabel } from "./schedulerLabels.js";

// Issue 185: majiteľ si všimol, že "posta-uncollected"/"order-reminder"/
// "shoptet-writeback"/"order-note-writeback" sa v tabuľke "História behov"
// zobrazujú holým technickým názvom namiesto slovenského popisu (chýbali v
// `JOB_LABELS`). Regresný test na presne tento nález — over KAŽDÝ zo štyroch
// mien, nielen že mapa "má nejaký kľúč".
it("jobLabel pozná všetky štyri novšie joby (issue 185) — nevracia holý technický názov", () => {
  expect(jobLabel("posta-uncollected")).toBe("Nevyzdvihnuté zásielky");
  expect(jobLabel("order-reminder")).toBe("Pripomienky objednávok");
  expect(jobLabel("shoptet-writeback")).toBe("Spätný zápis dodávateľa do Shoptetu");
  expect(jobLabel("order-note-writeback")).toBe("Spätný zápis poznámky do Shoptetu");
});

it("jobLabel vráti holý technický názov pre naozaj neznámy job (fallback nezmenený)", () => {
  expect(jobLabel("neexistujuci-job")).toBe("neexistujuci-job");
});

// Issue 387 (dolaďovačka z prvého ostrého behu): "pairing-search"
// (`PAIRING_SEARCH_JOB_NAME`, apps/api/src/modules/pairing-search/
// constants.ts) chýbalo v JOB_LABELS, takže Plánovač ukazoval surový
// technický názov namiesto slovenského popisu — presne ten istý nález
// ako issue 185, len o job neskôr.
it("jobLabel pozná pairing-search (issue 387) — nevracia holý technický názov", () => {
  expect(jobLabel("pairing-search")).toBe("Párovanie: nočný zber kandidátov u dodávateľov");
});

// Issue 402: "shop-sitemap" (`SHOP_SITEMAP_JOB_NAME`) — rovnaká medzera ako
// issue 185/387 vyššie, chytená TOTO ISTÝM regresným testom nižšie.
it("jobLabel pozná shop-sitemap (issue 402) — nevracia holý technický názov", () => {
  expect(jobLabel("shop-sitemap")).toBe("Adresy z mapy stránok (doplnok k feedu)");
});

it("JOB_LABELS pozná presne 11 jobov (5 pôvodných + 4 z issue 185 + 1 z issue 387 + 1 z issue 402) — žiadny sa nestratil", () => {
  expect(Object.keys(JOB_LABELS)).toHaveLength(11);
});
