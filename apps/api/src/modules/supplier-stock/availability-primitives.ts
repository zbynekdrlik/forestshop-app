// Základné, závislosťami nezaťažené funkcie zdieľané medzi `parse.ts`
// (generický algoritmus) a `availability-domain-rules.ts` (per-doménové
// pravidlá) — vyčlenené v code review na issue 307, aby oba súbory záviseli
// JEDNÝM smerom na tomto (nikdy nie navzájom na sebe). Predtým
// `availability-domain-rules.ts` importoval `availabilityFromText`/`hostOf`
// späť z `parse.ts`, zatiaľ čo `parse.ts` importoval per-doménové pravidlá z
// neho — funkčne bezpečný cyklický import (nič sa nevyhodnocuje na
// module-top-level v konfliktnom poradí, overené `tsc`/testami), ale krehký:
// budúci top-level kód v ktoromkoľvek súbore (napr. memoizovaný index) by ho
// mohol ticho rozbiť. Táto extrakcia cyklus odstraňuje úplne, nielen
// dokumentuje jeho bezpečnosť.

export type SupplierAvailability = "available" | "unavailable" | "unknown";

/**
 * Jedna kombinácia (veľkosť) na enumeráciu — `url` je adresa, z ktorej sa
 * dostupnosť TEJTO veľkosti prečíta, `label` je jej viditeľný názov (napr.
 * "52"). Vyčlenené sem (nie do `parse.ts`), aby ho `availability-domain-
 * rules.ts` (per-doménová enumerácia, issue 552) mohol vracať bez cyklického
 * importu späť z `parse.ts` — rovnaká jednosmerná disciplína ako
 * `SupplierAvailability`/`hostOf`.
 */
export interface CombinationTarget {
  readonly url: string;
  readonly label: string;
}

/** Doména bez `www.`, malými písmenami. Neplatná URL → prázdny reťazec. */
export function hostOf(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * Dekóduje ČÍSELNÉ HTML entity (`&#xHH;`/`&#DDD;`) na skutočný znak — nikdy
 * ich len nevyprázdňuje. Zistené code review na issue 307:
 * `roslerStockRegion`'s pôvodné `.replace(/&#x[0-9a-fA-F]+;/gi, " ")`
 * (skopírované z `lesonaVisibleAvailability`, kde je vyprázdnenie SPRÁVNE —
 * tam ide o Material-Icons kódové body v Private Use Area, nie o skutočný
 * text) na rosler.sk TICHO ROZBÍJALO diakritiku: stránka kóduje KAŽDÚ
 * diakritiku takto (naživo overené — "dn&#xED;" = "dní", "no&#x17E;e" =
 * "nože", "ma&#xE1;" = "malá"), takže "vypredan&#xE9;" by sa vyprázdnením
 * zmenilo na "vypredan " — nezhoduje sa so ŽIADNYM slovom v
 * `OUT_KEYWORDS`/`IN_KEYWORDS`, extraktor by ticho spadol na `unknown`
 * namiesto `unavailable`. Skutočné dekódovanie funguje rovnako správne pre
 * OBA prípady: diakritika sa zmení na svoj skutočný znak (zhodu nájde
 * `availabilityFromText`), ikonkový kódový bod sa zmení na neviditeľný
 * Private-Use-Area znak (nezhoduje sa so žiadnym slovom, rovnaký výsledný
 * efekt ako predošlé vyprázdnenie) — žiadny dôvod mať dve rôzne funkcie.
 */
export function decodeNumericEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

// Vypredané sa kontroluje PRVÉ — stránka, ktorá povie "Vypredané", je
// rozhodná aj keď sa inde na nej vyskytne slovo "skladom" (napr. v odporúčaných
// produktoch). Slovenské, české aj anglické tvary, s diakritikou aj bez nej.
const OUT_KEYWORDS: readonly string[] = Object.freeze([
  "vypredané",
  "vypredane",
  "vypredaný",
  "vypredany",
  "vyprodáno",
  "vyprodano",
  "nedostupné",
  "nedostupne",
  "nedostupný",
  "nedostupny",
  "nie je skladom",
  "není skladem",
  "neni skladem",
  "momentálne nedostupné",
  "momentalne nedostupne",
  // Český tvar s mäkkým "ě" (issue 227, tenolix.cz) — INÝ reťazec než
  // slovenské "momentálne" vyššie, obe sa musia kontrolovať samostatne.
  "momentálně nedostupné",
  "dočasne nedostupné",
  "docasne nedostupne",
  "predaj skončil",
  "predaj skoncil",
  "out of stock",
  "sold out",
]);

const IN_KEYWORDS: readonly string[] = Object.freeze([
  "skladom",
  "na sklade",
  "skladem",
  "ihneď k odberu",
  "ihned k odberu",
  "posledné kusy",
  "posledne kusy",
  "posledný kus",
  "posledny kus",
  "in stock",
]);

/**
 * Dostupnosť z voľného textu. Vypredané vyhráva nad skladom (rozhodný zápor).
 * Vracia aj to, KTORÉ slovo rozhodlo — ide do `availabilityText`, aby bolo
 * v appke vidieť, na základe čoho sa rozhodlo.
 */
export function availabilityFromText(text: string): {
  readonly availability: SupplierAvailability;
  readonly matched: string;
} {
  const lower = text.toLowerCase();
  const out = OUT_KEYWORDS.find((keyword) => lower.includes(keyword));
  if (out !== undefined) return { availability: "unavailable", matched: out };
  const inStock = IN_KEYWORDS.find((keyword) => lower.includes(keyword));
  if (inStock !== undefined) return { availability: "available", matched: inStock };
  return { availability: "unknown", matched: "" };
}

/** Veľkostné výrazy, ktoré NORMALIZOVANÝ (bez diakritiky/veľkosti písmen/nepísmen)
 * názov parametra/atribútovej skupiny musí OBSAHOVAŤ (nie len presne rovnať sa im).
 * „veľkosť" po odstránení diakritiky = `velkost`; `velikost` je český tvar, `size`
 * anglický. Obsahová (nie prefixová) zhoda pokrýva obe strany parsera: Shoptet
 * „Veľkosť PONOŽKY" → `velkostponozky` (issue 566) aj PrestaShop/wetland „Konfekčná
 * veľkosť" → `konfekcnavelkost` (issue 556 zvyšok). */
const SIZE_NAME_TERMS: readonly string[] = Object.freeze(["velikost", "velkost", "size"]);

/** Negatívny zoznam (issue 566): normalizované podreťazce, ktoré veľkostný výraz
 * síce OBSAHUJÚ, ale variantovou veľkosťou kusu NIE SÚ — napr. „Veľkosť balenia"
 * (`velkostbalenia` = veľkosť multipacku, nie kusu). Porovnáva sa `.includes()`,
 * takže jediný podreťazec `baleni` pokrýva všetky tvary — sk „balenie"/„balenia"
 * (`velkostbalenia`/`velkostbalenie`) aj cz „balení" (`baleni`). „Optické zvětšení"
 * (hunting24.cz) veľkostný výraz VÔBEC neobsahuje, takže ho odmietne už samotná
 * obsahová zhoda — tento zoznam je poistka pre parametre, ktoré veľkostné slovo
 * obsahujú v inom význame. */
const NON_SIZE_NAME_TERMS: readonly string[] = Object.freeze(["baleni"]);

/** `true`, keď NORMALIZOVANÝ názov parametra/skupiny označuje variantovú VEĽKOSŤ —
 * obsahuje veľkostný výraz a zároveň žiadny výraz z negatívneho zoznamu. Jediný
 * zdroj pravdy pre OBE strany parsera (Shoptet `findSizeParam`,
 * `shoptet-multivariant.ts`; PrestaShop/wetland `isWetlandSizeGroup`,
 * `availability-domain-rules.ts`) — vstupom je už normalizovaný reťazec (každá
 * strana normalizuje vlastnou, ale zhodnou NFD funkciou). */
export function isSizeParamName(normalized: string): boolean {
  if (NON_SIZE_NAME_TERMS.some((term) => normalized.includes(term))) return false;
  return SIZE_NAME_TERMS.some((term) => normalized.includes(term));
}
