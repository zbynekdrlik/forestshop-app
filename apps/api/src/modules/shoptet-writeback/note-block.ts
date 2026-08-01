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

// Zachytí AJ 1-2 prázdne riadky BEZPROSTREDNE PRED blokom (LF aj CRLF, issue
// 169 — pôvodné `\n{1,2}` chytalo len LF), aby odstránenie bloku (ourNote
// prázdny) nenechalo za sebou osamotené prázdne riadky — `mergeShopRemark`
// nižšie potom sám pridáva PRESNE jeden oddeľovací prázdny riadok pri
// opätovnom pripojení, takže výsledok je vždy deterministický bez ohľadu na
// to, koľkokrát sa blok odstráni/pridá.
const OUR_BLOCK_PATTERN = `(?:(?:\\r?\\n){1,2})?${escapeForRegex(NOTE_BLOCK_START)}[\\s\\S]*?${escapeForRegex(NOTE_BLOCK_END)}`;

// Bez `/g` flagu — používaný VÝHRADNE pre `.test()` (`hasOurBlock`). Global
// regexy sú stavové (`lastIndex` prežíva medzi volaniami na TOM ISTOM
// objekte) — opakované `.test()` volania na rôznych reťazcoch (presne
// vzor v teste nižšie) by so zdieľaným globálnym objektom mohli tichým
// spôsobom vrátiť `false` napriek reálnej zhode. Preto zámerne SAMOSTATNÝ
// objekt od toho, čo používa `.replace()` nižšie.
const OUR_BLOCK_RE = new RegExp(OUR_BLOCK_PATTERN);

// S `/g` flagom — používaný VÝHRADNE pre `.replace()` (issue 169: bez `/g`
// `String.prototype.replace()` odstráni len PRVÝ výskyt nášho bloku, druhý
// by unikol do "cudzej" časti). `.replace()` s globálnym regexom si sám
// resetuje `lastIndex` na 0 pred aj po behu, takže je bezpečný aj pri
// opakovanom volaní `mergeShopRemark` — na rozdiel od `.test()` vyššie preto
// zostáva zámerne oddelený objekt, nikdy zdieľaný s `OUR_BLOCK_RE`.
const OUR_BLOCK_RE_GLOBAL = new RegExp(OUR_BLOCK_PATTERN, "g");

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

  const withoutOurBlock = existing.replace(OUR_BLOCK_RE_GLOBAL, "");

  if (trimmedNote === "") {
    return withoutOurBlock;
  }

  const block = buildBlock(trimmedNote);
  if (withoutOurBlock === "") {
    return block;
  }
  return `${withoutOurBlock}\n\n${block}`;
}

/**
 * issue 164: čítacia strana importu — z RAW hodnoty Shoptet-ovho "Poznámka
 * e-shopu" poľa (`order.shop_remark`, tak ako prišla z CSV exportu, môže
 * niesť AJ náš vlastný blok) vráti LEN cudziu (nie-appkinu) časť, na
 * zobrazenie read-only. Tenký wrapper nad `mergeShopRemark(raw, null)`, ktoré
 * náš blok už dnes odstraňuje (`ourNote=null` vetva vyššie) — tu sa len
 * orezáva zvyšný text a prázdny reťazec sa mapuje na `null` (rovnaký zámer
 * ako `parser.ts`'s `rawRemark === "" ? null : rawRemark`). Appkina VLASTNÁ
 * poznámka (`order.comment`) je nezávislá od tejto funkcie — zobrazuje sa
 * priamo z vlastného stĺpca, nikdy sa neodvodzuje z tohto bloku.
 */
export function extractForeignShopRemark(shopRemarkRaw: string | null): string | null {
  const foreign = mergeShopRemark(shopRemarkRaw, null).trim();
  return foreign === "" ? null : foreign;
}
