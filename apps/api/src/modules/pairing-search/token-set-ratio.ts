// Vlastná implementácia `rapidfuzz.fuzz.token_set_ratio` (issue 387 E1).
// Návrh (issue 387 komentár, sekcia „Čo sa portuje 1:1") povolil buď
// knižnicu `fuzzball`, alebo vlastnú implementáciu s fixtúrovými testami
// proti výstupom starej appky — nainštalovaná `fuzzball` (npm) na batérii
// príkladov z návrhu dáva VÝRAZNE odlišné hodnoty od skutočnej rapidfuzz
// (napr. "Strike Nohavice DEERHUNTER 3989-388" vs "Strike Nohavice
// Deerhunter 3989": rapidfuzz 66,67, fuzzball 100 — fuzzball si vstup
// interne inak predspracúva/lowercase-uje, rapidfuzz je case-SENSITIVE a
// stará appka volá `fuzz.token_set_ratio` priamo bez `.lower()`), preto
// vlastná implementácia nižšie.
//
// Algoritmus overený proti nainštalovanej `rapidfuzz` (pip, verzia
// 3.14.5) na 700 náhodných + štruktúrovaných dvojiciach vrátane
// slovenskej diakritiky — 700/700 zhoda na desatinné miesto (scratchpad
// skript použitý pri overovaní, nekomitovaný). Vzorec:
//   ratio(a,b)          = (1 - indelDistance(a,b) / (len(a)+len(b))) * 100
//   indelDistance(a,b)  = len(a) + len(b) - 2 * LCS(a,b)
//   tokenSetRatio(s1,s2) = max(ratio(sect, 1to2), ratio(sect, 2to1), ratio(1to2, 2to1))
// kde `sect`/`1to2`/`2to1` sú zoradené (Unicode code-point poradie, presne
// ako Python's `sorted()`) reťazce zostavené z prieniku a rozdielov
// množín tokenov — klasický fuzzywuzzy/rapidfuzz `token_set_ratio`
// algoritmus, ktorý stará appka používa cez `rapidfuzz.fuzz`.

/** Dĺžka najdlhšej spoločnej podpostupnosti (LCS) — DP O(n·m), n/m sú dĺžky
 * jednotlivých dopytov/mien (rádovo desiatky znakov), nikdy veľké vstupy. */
function lcsLength(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    const curr = new Array<number>(m + 1).fill(0);
    for (let j = 1; j <= m; j += 1) {
      const match = a[i - 1] === b[j - 1];
      curr[j] = match ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
    }
    prev = curr;
  }
  return prev[m] ?? 0;
}

/** Port `rapidfuzz.fuzz.ratio` (Indel-distance-based normalizovaná zhoda). */
function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 100;
  const distance = total - 2 * lcsLength(a, b);
  return (1 - distance / total) * 100;
}

function tokenize(s: string): string[] {
  const trimmed = s.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}

/**
 * Port `rapidfuzz.fuzz.token_set_ratio(s1, s2)` — case-SENSITIVE, žiadne
 * predspracovanie okrem tokenizácie na whitespace (presne ako stará appka
 * volá rapidfuzz priamo bez `.lower()`/`full_process`). Prázdny/len-
 * whitespace vstup na oboch stranách → 0 (rapidfuzz's `validate_string`
 * guard — overené empiricky, nevyplýva to len z tokenizácie).
 */
export function tokenSetRatio(s1: string, s2: string): number {
  if (s1.trim() === "" || s2.trim() === "") return 0;

  const tokens1 = new Set(tokenize(s1));
  const tokens2 = new Set(tokenize(s2));

  const intersection = [...tokens1].filter((t) => tokens2.has(t)).sort();
  const diff1to2 = [...tokens1].filter((t) => !tokens2.has(t)).sort();
  const diff2to1 = [...tokens2].filter((t) => !tokens1.has(t)).sort();

  const sortedSect = intersection.join(" ");
  const sorted1to2 = `${sortedSect} ${diff1to2.join(" ")}`.trim();
  const sorted2to1 = `${sortedSect} ${diff2to1.join(" ")}`.trim();

  return Math.max(ratio(sortedSect, sorted1to2), ratio(sortedSect, sorted2to1), ratio(sorted1to2, sorted2to1));
}
