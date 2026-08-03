import type { TemplateValue } from "./render.js";

// issue 192: hodnoty polí, ktoré sú dostupné v KAŽDEJ šablóne. Sú tu (a nie v
// `registry.ts`), aby ich používali OBE strany rovnako — ukážka v ponuke polí
// aj skutočné odoslanie. Inak by sa náhľad mohol rozísť s tým, čo naozaj
// odíde zákazníkovi.
export const KONTAKT_EMAIL = "eshop@forestshop.sk";
export const KONTAKT_TELEFON = "+421 903 670 766";
export const WEB_FORESTSHOP = "https://www.forestshop.sk";

export function globalContext(): Record<string, TemplateValue> {
  return {
    kontakt_email: { kind: "link", url: `mailto:${KONTAKT_EMAIL}`, label: KONTAKT_EMAIL },
    kontakt_telefon: { kind: "link", url: `tel:${KONTAKT_TELEFON.replaceAll(" ", "")}`, label: KONTAKT_TELEFON },
    web_forestshop: { kind: "link", url: WEB_FORESTSHOP, label: "www.forestshop.sk" },
  };
}

export function textValue(value: string): TemplateValue {
  return { kind: "text", text: value };
}
