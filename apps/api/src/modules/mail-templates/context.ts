import type { TemplateValue } from "./render.js";

// issue 192: hodnoty polí, ktoré sú dostupné v KAŽDEJ šablóne. Sú tu (a nie v
// `registry.ts`), aby ich používali OBE strany rovnako — ukážka v ponuke polí
// aj skutočné odoslanie. Inak by sa náhľad mohol rozísť s tým, čo naozaj
// odíde zákazníkovi.
export const KONTAKT_EMAIL = "eshop@forestshop.sk";
export const KONTAKT_TELEFON = "+421 903 670 766";
export const WEB_FORESTSHOP = "https://www.forestshop.sk";
// issue 379: čitateľná forma webovej adresy — TÁ ISTÁ, akú ukazuje
// `{{web_forestshop}}` aj pätička (`layout.ts`). Vytiahnutá sem, aby oba
// miesta nemohli rozísť (predtým bol reťazec "www.forestshop.sk" napísaný
// natvrdo na dvoch miestach).
export const WEB_FORESTSHOP_LABEL = "www.forestshop.sk";

// issue 379: majiteľ nahlásil, že telefón/e-mail/web sa v e-maile
// opakujú — jeden zo zdrojov bola TÁTO textová verzia odkazu sama osebe:
// `{{kontakt_email}}` v textovom móde vypisovala "eshop@forestshop.sk
// (mailto:eshop@forestshop.sk)", lebo `label` a `url` sa formálne líšia
// (predpona mailto:/tel:), hoci nesú TÚ ISTÚ informáciu. `showUrlInText:
// false` vypína práve TÚTO zátvorku pre kontaktné polia — na rozdiel od
// napr. produktového odkazu (`zoznam_nahrad`), kde adresa v texte naozaj
// treba (nedá sa kliknúť), tu je čitateľná hodnota už sama plne dostačujúca.
export function globalContext(): Record<string, TemplateValue> {
  return {
    kontakt_email: { kind: "link", url: `mailto:${KONTAKT_EMAIL}`, label: KONTAKT_EMAIL, showUrlInText: false },
    kontakt_telefon: { kind: "link", url: `tel:${KONTAKT_TELEFON.replaceAll(" ", "")}`, label: KONTAKT_TELEFON, showUrlInText: false },
    web_forestshop: { kind: "link", url: WEB_FORESTSHOP, label: WEB_FORESTSHOP_LABEL, showUrlInText: false },
  };
}

export function textValue(value: string): TemplateValue {
  return { kind: "text", text: value };
}
