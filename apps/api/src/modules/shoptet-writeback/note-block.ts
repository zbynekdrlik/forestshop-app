// issue 123: appkina poznámka k objednávke (`order.comment`) sa do Shoptetu
// zapisuje ako VLASTNÝ ohraničený blok vnútri Shoptet-ovho "Poznámka
// e-shopu" poľa (`textarea[name="shopRemark"]` na `/admin/objednavky-
// detail/`, naživo overené pri návrhu tohto ticketu) — NIKDY neprepisuje
// celé pole. Majiteľovo rozhodnutie (zadanie dispatchu): appka sa PRIPÁJA,
// nikdy nenahrádza ručne napísaný text okolo. Toto je čisto textová funkcia
// (žiadny DB/Playwright prístup) — jednoducho testovateľná bez fixtúry.

export const NOTE_BLOCK_START = "--- poznámka z appky ---";
export const NOTE_BLOCK_END = "--- koniec ---";

function escapeForRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Zachytí AJ 1-2 prázdne riadky BEZPROSTREDNE PRED blokom, aby odstránenie
// bloku (ourNote prázdny) nenechalo za sebou osamotené prázdne riadky —
// `mergeShopRemark` nižšie potom sám pridáva PRESNE jeden oddeľovací
// prázdny riadok pri opätovnom pripojení, takže výsledok je vždy
// deterministický bez ohľadu na to, koľkokrát sa blok odstráni/pridá.
const OUR_BLOCK_RE = new RegExp(
  `(?:\\n{1,2})?${escapeForRegex(NOTE_BLOCK_START)}[\\s\\S]*?${escapeForRegex(NOTE_BLOCK_END)}`,
);

function buildBlock(note: string): string {
  return `${NOTE_BLOCK_START}\n${note}\n${NOTE_BLOCK_END}`;
}

/** `true`, keď `text` obsahuje náš ohraničený blok (na hocijakom mieste). */
export function hasOurBlock(text: string): boolean {
  return OUR_BLOCK_RE.test(text);
}

/**
 * Zloží novú hodnotu Shoptet-ovho "Poznámka e-shopu" poľa z jeho AKTUÁLNEHO
 * obsahu (`existingShopRemark`, `null`/`""` keď pole zatiaľ prázdne) a
 * appkinej poznámky (`ourNote`, `null`/prázdny reťazec po orezaní = appka
 * nemá čo zapísať, teda ODSTRÁNI svoj blok, ak tam nejaký je).
 *
 * - Náš blok UŽ v texte je → nahradí sa LEN jeho obsah, ručný text okolo sa
 *   nedotkne.
 * - Náš blok tam NIE JE a `ourNote` má obsah → pripojí sa na koniec (za
 *   oddeľovacím prázdnym riadkom, ak existujúci text niečo obsahuje).
 * - `ourNote` prázdny/`null` → odstráni sa LEN náš blok (aj s prípadným
 *   oddeľovacím prázdnym riadkom pred ním), zvyšok textu ostáva presne
 *   taký, aký bol.
 *
 * Idempotentné: opätovné volanie s TOU ISTOU `ourNote` na výsledku
 * predchádzajúceho volania vráti nezmenený reťazec (žiadne hromadenie
 * prázdnych riadkov ani duplicitných blokov).
 */
export function mergeShopRemark(existingShopRemark: string | null, ourNote: string | null): string {
  const existing = existingShopRemark ?? "";
  const trimmedNote = ourNote?.trim() ?? "";

  const withoutOurBlock = existing.replace(OUR_BLOCK_RE, "");

  if (trimmedNote === "") {
    return withoutOurBlock;
  }

  const block = buildBlock(trimmedNote);
  if (withoutOurBlock === "") {
    return block;
  }
  return `${withoutOurBlock}\n\n${block}`;
}
