// Slovenské skloňovanie počtu — presná zhoda so starou appkou
// (`parovanie_produktov/webreview/static/app.js:1972-1979`, `pluralWord`/
// `itemsWord`), reprodukovaná verne pre mailový predmet/telo (#31): 1 →
// jednotné číslo, 2-4 → "málo" tvar, 0 aj 5+ → "veľa" tvar.
export function pluralWord(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  return n >= 2 && n <= 4 ? few : many;
}

export function itemsWord(n: number): string {
  return pluralWord(n, "položka", "položky", "položiek");
}
