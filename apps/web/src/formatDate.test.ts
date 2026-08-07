import { expect, it } from "vitest";
import { formatSkDate, formatSkDateInZone, formatSkDateTime } from "./formatDate.js";

// issue 293: jediná spoločná funkcia na slovenský tvar dátumu/času —
// `timeZone: "Europe/Bratislava"` je VÝSLOVNE nastavené, takže výsledok
// nezávisí od pásma nastaveného na počítači toho, kto sa práve pozerá.

it("formatSkDate: bežný okamih v slovenskom tvare", () => {
  expect(formatSkDate("2026-08-06T12:00:00.000Z")).toBe("6. 8. 2026");
});

it("formatSkDate: okamih tesne PO slovenskej polnoci sa zobrazí ako DNEŠNÝ deň, nie UTC-VČEREJŠÍ", () => {
  // 2026-08-05T22:10:00Z = 2026-08-06 00:10 Europe/Bratislava (letný čas).
  expect(formatSkDate("2026-08-05T22:10:00.000Z")).toBe("6. 8. 2026");
});

it("formatSkDateInZone: bare YYYY-MM-DD kalendárny deň sa formátuje rovnako bez ohľadu na znamienko posunu pásma", () => {
  // Pacific/Honolulu je vždy UTC-10 (žiadny letný čas — deterministický
  // záporný posun). `new Date("2026-08-06")` je UTC polnoc; v Bratislave
  // (kladný posun) to vždy vyjde ako ten istý/nasledujúci deň, takže
  // formatSkDate samotné (pevné na Europe/Bratislava) tento bug nevidí —
  // preto sa testuje priamo cez formatSkDateInZone so záporným pásmom.
  expect(formatSkDateInZone("2026-08-06", "Pacific/Honolulu")).toBe("6. 8. 2026");
});

it("formatSkDate: prijme aj Date objekt priamo", () => {
  expect(formatSkDate(new Date("2026-08-06T12:00:00.000Z"))).toBe("6. 8. 2026");
});

it("formatSkDate: prázdny/neplatný/chýbajúci vstup → pomlčka", () => {
  expect(formatSkDate("")).toBe("—");
  expect(formatSkDate(null)).toBe("—");
  expect(formatSkDate(undefined)).toBe("—");
  expect(formatSkDate("nezmysel")).toBe("—");
});

it("formatSkDateTime: dátum + čas bez sekúnd", () => {
  expect(formatSkDateTime("2026-08-06T12:40:11.000Z")).toBe("6. 8. 2026 14:40");
});

it("formatSkDateTime: prázdny/neplatný vstup → pomlčka", () => {
  expect(formatSkDateTime("")).toBe("—");
  expect(formatSkDateTime("nezmysel")).toBe("—");
});
