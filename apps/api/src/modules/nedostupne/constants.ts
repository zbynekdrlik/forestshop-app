// issue 176: "Nedostupné tovary" — konštanty prevzaté zo starej appky
// (`parovanie_produktov/src/parovanie/nedostupne.py`), preto komentáre na
// viacerých miestach citujú presne odtiaľ.

export const TYPE_UNAVAILABLE = "nedostupne" as const;
export const TYPE_ALTERNATIVE = "alternativa" as const;
export const EMAIL_TYPES = [TYPE_UNAVAILABLE, TYPE_ALTERNATIVE] as const;
export type NedostupneEmailType = (typeof EMAIL_TYPES)[number];

// issue 238: pôvodný automatický vyhľadávací fallback (`alternativeSearchUrl`)
// je preč spolu s celým `product.relatedCodes`-based návrhom — majiteľ teraz
// vkladá skutočné odkazy sám (`nedostupne_replacement_link`), appka už
// žiadny odkaz sama neskladá.

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
