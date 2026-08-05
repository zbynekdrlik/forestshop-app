// issue 264: JEDNA zdieľaná funkcia, čo premietne farby do CSS premenných na
// `document.documentElement` — používa ju AJ štart appky (App.tsx, po
// prihlásení, pre KAŽDÉHO používateľa) AJ živý náhľad v popupe (Theme
// ColorPicker, pri každej zmene/ťahaní paletou). Inline štýl na root prvku má
// vyššiu prioritu než `:root` pravidlo v `app.css`, takže sa prejaví
// OKAMŽITE na celej stránke bez akéhokoľvek React re-renderu — presne to,
// čo ticket žiada ("naživo... sa mu to bude meniť na stránke").
export function applyThemeColors(values: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(values)) {
    document.documentElement.style.setProperty(`--${key}`, value);
  }
}
