// issue 264: register šiestich upraviteľných farieb bublinek dodávateľov
// (issue 263). Predvolené hodnoty sú PRESNÝMI hex kódmi, čo dnes žijú
// natvrdo v `apps/web/src/styles/app.css`'s `:root` — pri "Obnoviť
// predvolené" sa musia zhodovať bajt na bajt s tým, čo appka ukazovala PRED
// týmto ticketom.

export const THEME_COLOR_KEYS = [
  "chip-done-bg",
  "chip-done-text",
  "chip-todo-bg",
  "chip-todo-text",
  "chip-active-bg",
  "chip-active-text",
] as const;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

export function isThemeColorKey(value: string): value is ThemeColorKey {
  return (THEME_COLOR_KEYS as readonly string[]).includes(value);
}

export interface ThemeColorKind {
  readonly label: string;
  readonly defaultValue: string;
}

export const THEME_COLOR_KINDS: Readonly<Record<ThemeColorKey, ThemeColorKind>> = {
  "chip-done-bg": { label: "Vybavený dodávateľ — pozadie", defaultValue: "#d14d3b" },
  "chip-done-text": { label: "Vybavený dodávateľ — text", defaultValue: "#ffffff" },
  "chip-todo-bg": { label: "Nespracovaný dodávateľ — pozadie", defaultValue: "#6cab68" },
  "chip-todo-text": { label: "Nespracovaný dodávateľ — text", defaultValue: "#173617" },
  "chip-active-bg": { label: "Práve zvolená bublinka — pozadie", defaultValue: "#dda43c" },
  "chip-active-text": { label: "Práve zvolená bublinka — text", defaultValue: "#3b1d00" },
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

/** Overí presne túto množinu kľúčov (žiadny chýbajúci, žiadny navyše) a že
 * KAŽDÁ hodnota je platný hex kód "#rrggbb" — vracia zoznam zrozumiteľných
 * slovenských chýb, prázdny zoznam = v poriadku. Volá sa PRED zápisom, aby
 * sa neplatný kód farby nikdy nedostal do databázy (rovnaký "over pred
 * zápisom" vzor ako `mail-templates/render.ts`'s `validateTemplateText`). */
export function validateThemeColorValues(values: Readonly<Record<string, string>>): readonly string[] {
  const errors: string[] = [];
  const givenKeys = new Set(Object.keys(values));

  for (const key of THEME_COLOR_KEYS) {
    if (!givenKeys.has(key)) {
      errors.push(`Chýba farba „${THEME_COLOR_KINDS[key].label}“.`);
      continue;
    }
    const value = values[key] ?? "";
    if (!isValidHexColor(value)) {
      errors.push(`Neplatný kód farby pre „${THEME_COLOR_KINDS[key].label}“ — očakávaný tvar #rrggbb.`);
    }
  }

  for (const key of givenKeys) {
    if (!isThemeColorKey(key)) errors.push(`Neznámy kľúč farby „${key}“.`);
  }

  return errors;
}
