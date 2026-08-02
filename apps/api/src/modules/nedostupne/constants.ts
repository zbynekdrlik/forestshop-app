// issue 176: "Nedostupné tovary" — konštanty prevzaté zo starej appky
// (`parovanie_produktov/src/parovanie/nedostupne.py`), preto komentáre na
// viacerých miestach citujú presne odtiaľ.

export const TYPE_UNAVAILABLE = "nedostupne" as const;
export const TYPE_ALTERNATIVE = "alternativa" as const;
export const EMAIL_TYPES = [TYPE_UNAVAILABLE, TYPE_ALTERNATIVE] as const;
export type NedostupneEmailType = (typeof EMAIL_TYPES)[number];

export const UNAVAILABLE_SUBJECT = "Informácia o dostupnosti vašej objednávky — Forestshop.sk";
export const ALTERNATIVE_SUBJECT = "Alternatívy k vášmu tovaru — Forestshop.sk";

// Klikateľný fallback na vyhľadávanie podľa kódu — appka nemá žiadny zdroj
// SKUTOČNEJ Shoptet produktovej URL (overené priamo na exporte: žiadny
// `url`/`seoUrl` stĺpec), takže sa používa VŽDY (rovnaký fallback ako stará
// appka's `_resolve_alternatives`, keď jej marketingový XML-feed lookup
// nenašiel zhodu — "always clickable"). Návrhový komentár na issue 176:
// import starého marketingového feedu bol zámerne zamietnutý ako nová,
// nepotrebná externá integrácia len kvôli jednému nepovinnému bodu ticketu.
export function alternativeSearchUrl(code: string): string {
  return `https://www.forestshop.sk/vyhladavanie/?string=${encodeURIComponent(code)}`;
}

// Ďalší voľný kľúč v registri `.claude/rules/scheduler.md`
// (787_878_001/002/003/004/005/100 sú obsadené) — serializuje KAŽDÉ
// odoslanie tohto modulu (dedup-check + skutočné odoslanie + zápis stavu je
// TOCTOU okno bez tohto zámku: dva súbežné klik-y na TEN ISTÝ (objednávka,
// variant, typ) by mohli OBA prejsť `hasSentNedostupne` skôr, než ktorýkoľvek
// zapíše, a poslať zákazníkovi e-mail DVAKRÁT — presne to, čomu má dedup
// zabrániť). Rovnaký zámer ako #172/#173's RUN lock, len na úrovni
// JEDNÉHO odoslania namiesto celého dávkového behu (tento modul žiadny beh
// nemá).
export const NEDOSTUPNE_SEND_LOCK_KEY = 787_878_006;
