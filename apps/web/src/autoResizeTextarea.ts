// issue 410: "Objednávky predajňa" — voľná textarea, ktorá RASTIE pri Enter
// aj Shift+Enter (ticket). `<textarea>` samo osebe pri OBOCH klávesách len
// pridá nový riadok a NIKDY neodošle formulár (na rozdiel od `<input>`u) —
// appka preto nezachytáva žiadnu klávesu, len RUČNE prispôsobí výšku
// obsahu pri každej zmene (žiadny CSS-only `field-sizing: content` — nie je
// isté, že appka smie spoliehať len na prehliadače, čo ho podporujú).
export function autoResizeTextarea(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  const next = el.scrollHeight;
  // jsdom (vitest) vždy vráti 0 — nikdy neprepíš na "0px", to by v
  // testovacom prostredí zbytočne skrylo prvok.
  if (next > 0) el.style.height = `${String(next)}px`;
}
