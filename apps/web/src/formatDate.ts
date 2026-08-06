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

const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Jadro `formatSkDate` s explicitným pásmom (testovateľné samostatne —
 * `TIME_ZONE` nižšie je zámerne kladný posun, takže bug pri bare
 * `YYYY-MM-DD` vstupe cez ňu nejde vidieť).
 *
 * Bare `YYYY-MM-DD` (žiadna časová zložka) sa formátuje PRIAMO zo svojich
 * Y/M/D znakov, nikdy cez inštanciu (`new Date(...)`) prehnanú cez `zone` —
 * `new Date("YYYY-MM-DD")` parsuje ako UTC POLNOC a jej prevod do pásma so
 * ZÁPORNÝM posunom vráti PREDCHÁDZAJÚCI kalendárny deň (pozri red test
 * vyššie). `Date` sa tu použije LEN na validáciu (odmietnutie neplatného
 * kalendárneho dátumu, napr. "2026-13-45"), nikdy na výpočet zobrazeného
 * dňa. Plný ISO okamih s časovou zložkou ide ĎALEJ cez pôvodnú,
 * inštanciovú vetvu — tá je correct, lebo vtedy naozaj ide o okamih, nie o
 * čistý kalendárny deň. */
export function formatSkDateInZone(value: string | Date | null | undefined, zone: string): string {
  if (typeof value === "string" && BARE_DATE_RE.test(value)) {
    if (toValidDate(value) === null) return "—";
    const [y, m, day] = value.split("-");
    return `${Number(day)}. ${Number(m)}. ${Number(y)}`;
  }
  const d = toValidDate(value);
  if (d === null) return "—";
  return d.toLocaleDateString("sk-SK", { timeZone: zone });
}

/** Slovenský tvar dátumu, napr. "6. 8. 2026". Prázdny/nerozpoznateľný
 * vstup → "—". */
export function formatSkDate(value: string | Date | null | undefined): string {
  return formatSkDateInZone(value, TIME_ZONE);
}

/** Slovenský tvar dátumu + času (bez sekúnd), napr. "6. 8. 2026 14:40".
 * Prázdny/nerozpoznateľný vstup → "—". */
export function formatSkDateTime(value: string | Date | null | undefined): string {
  const d = toValidDate(value);
  if (d === null) return "—";
  return d.toLocaleString("sk-SK", { timeZone: TIME_ZONE, dateStyle: "short", timeStyle: "short" });
}
