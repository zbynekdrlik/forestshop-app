// issue 410: "Objednávky predajňa" — voľná textarea, ktorá RASTIE pri Enter
// aj Shift+Enter (ticket). `<textarea>` samo osebe pri OBOCH klávesách len
// pridá nový riadok a NIKDY neodošle formulár (na rozdiel od `<input>`u) —
// appka preto nezachytáva žiadnu klávesu, len RUČNE prispôsobí výšku
// obsahu pri každej zmene (žiadny CSS-only `field-sizing: content` — nie je
// isté, že appka smie spoliehať len na prehliadače, čo ho podporujú).
//
// issue 593: volá ho hook `useAutoGrowTextarea` (fallback pre prehliadače bez
// CSS `field-sizing: content`). Pole má `overflow-y: auto` (CSS `.write-field`
// — strop `50vh`, za ním sa posúva) a appka má globálne `box-sizing: border-box`.
// `scrollHeight` je obsah + padding BEZ rámika, takže výška musí rámik
// (`offsetHeight − clientHeight`) pripočítať — inak by pod stropom chýbali
// 2px a zobrazil sa zbytočný posuvník. Strop drží CSS `max-height`.
export function autoResizeTextarea(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  const next = el.scrollHeight;
  const border = el.offsetHeight - el.clientHeight;
  // jsdom (vitest) vždy vráti 0 — nikdy neprepíš na "0px", to by v
  // testovacom prostredí zbytočne skrylo prvok.
  if (next > 0) el.style.height = `${String(next + border)}px`;
}
