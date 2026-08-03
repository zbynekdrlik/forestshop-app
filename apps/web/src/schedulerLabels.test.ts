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

it("JOB_LABELS pozná presne 9 jobov (5 pôvodných + 4 z issue 185) — žiadny sa nestratil", () => {
  expect(Object.keys(JOB_LABELS)).toHaveLength(9);
});
