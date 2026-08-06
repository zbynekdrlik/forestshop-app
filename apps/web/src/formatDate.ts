// Jediná spoločná funkcia na zobrazenie dátumu/času v appke — issue 293.
// Predtým takmer každá sekcia mala VLASTNÉ `toLocaleString`/
// `toLocaleDateString("sk-SK")` volanie (rôzne, jeden aj s desiatkami
// sekúnd navyše) a tri miesta navyše krájali surový ISO reťazec
// (`slice(0, 10)`) namiesto formátovania — to vždy vráti UTC kalendárny
// deň, takže čokoľvek medzi 22:00 a polnocou slovenského času sa ukázalo s
// dátumom VČEREJŠKA. `timeZone: "Europe/Bratislava"` je tu VÝSLOVNE
// nastavené (nie ponechané na predvolené pásmo prehliadača) — obrazovka
// tak ukazuje rovnaký slovenský dátum bez ohľadu na to, v akom pásme má
// nastavený svoj počítač ten, kto sa práve pozerá.
const TIME_ZONE = "Europe/Bratislava";

function toValidDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Slovenský tvar dátumu, napr. "6. 8. 2026". Prázdny/nerozpoznateľný
 * vstup → "—". */
export function formatSkDate(value: string | Date | null | undefined): string {
  const d = toValidDate(value);
  if (d === null) return "—";
  return d.toLocaleDateString("sk-SK", { timeZone: TIME_ZONE });
}

/** Slovenský tvar dátumu + času (bez sekúnd), napr. "6. 8. 2026 14:40".
 * Prázdny/nerozpoznateľný vstup → "—". */
export function formatSkDateTime(value: string | Date | null | undefined): string {
  const d = toValidDate(value);
  if (d === null) return "—";
  return d.toLocaleString("sk-SK", { timeZone: TIME_ZONE, dateStyle: "short", timeStyle: "short" });
}
