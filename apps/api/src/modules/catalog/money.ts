// Sumy zo Shoptetu sú reťazce s desatinnou ČIARKOU ("67,00"). Do databázy idú ako
// `numeric` (drizzle ich drží ako reťazec), takže sa nikde nedotknú `number` a
// nemôžu stratiť presnosť — okrem zaokrúhlenia na presne 2 desatinné miesta, ktoré
// si tento parser robí SÁM (reťazcovou/BigInt aritmetikou, nikdy cez `number`).
// Shoptet bežne exportuje nákupné ceny so 4 desatinnými miestami; bez tohto
// zaokrúhlenia by ich pri zápise do `numeric(_, 2)` stĺpca ticho zaokrúhlil až
// samotný Postgres — a nemuselo by to byť „pol nahor od nuly", ktoré tu robíme,
// aby uložená hodnota bola presne tá istá, akú vidí operátor. Mena je vždy vedľa
// sumy — `variant.currency` a CHECK `variant_money_needs_currency_ck` (Task 1) to
// vynucujú aj v databáze.

// Peňažné stĺpce (`price`, `standard_price`, `purchase_price`, `action_price`) sú
// `numeric(12, 2)` — najviac 10 číslic pred desatinnou čiarkou. Iné stĺpce s inou
// presnosťou (napr. `percent_vat`, `numeric(5, 2)`) si zvolia vlastný limit cez
// druhý parameter `parseDecimalComma` (pozri `map-row.ts`).
const MONEY_MAX_INTEGER_DIGITS = 10;

// Medzera/NBSP sa odstraňuje LEN keď je zjavným oddeľovačom tisícov — medzi
// číslicami a nasledovaná presne trojicou číslic, ktorá sama nepokračuje ďalšou
// číslicou. Iná medzera (napr. preklep "6 7,00") sa NEODSTRAŇUJE, aby sa mlčky
// nevyrobila hodnoverná, no nesprávna suma — taký reťazec zostane nečitateľný.
const SEPARATOR_RE = /(?<=\d)[ \u00a0](?=\d{3}(?!\d))/g;
const DECIMAL_RE = /^-?\d+(?:[.,]\d+)?$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/;

/**
 * Zaokrúhli reťazcovú desatinnú hodnotu (s bodkou) na presne 2 desatinné miesta,
 * „pol nahor od nuly" (rovnaké pravidlo, aké pri zápise do `numeric` stĺpca
 * používa Postgres) — výlučne reťazcovou/BigInt aritmetikou, nikdy cez `number`,
 * aby sa nezaviedla binárna chyba zaokrúhlenia. Hodnoty s najviac 2 desatinnými
 * miestami (vrátane žiadnych) vráti nezmenené.
 */
function roundToTwoDecimals(dotted: string): string {
  const negative = dotted.startsWith("-");
  const unsigned = negative ? dotted.slice(1) : dotted;
  const dot = unsigned.indexOf(".");
  if (dot === -1) return dotted;

  const intPart = unsigned.slice(0, dot);
  const fracPart = unsigned.slice(dot + 1);
  if (fracPart.length <= 2) return dotted;

  // O zaokrúhlení rozhoduje LEN tretia desatinná číslica — akékoľvek ďalšie
  // číslice za ňou už výsledok nezmenia (tretia číslica ≥5 vždy znamená, že
  // zvyšok tvorí aspoň polovicu druhého desatinného miesta).
  const roundUp = fracPart.charAt(2) >= "5";
  let cents = BigInt(intPart) * 100n + BigInt(fracPart.slice(0, 2));
  if (roundUp) cents += 1n;

  const centsStr = cents.toString().padStart(3, "0");
  const intOut = centsStr.slice(0, -2);
  const fracOut = centsStr.slice(-2);
  const sign = negative && cents !== 0n ? "-" : "";
  return `${sign}${intOut}.${fracOut}`;
}

/**
 * Vráti hodnotu vhodnú pre `numeric` stĺpec, alebo `null` — prázdne, nečitateľné
 * AJ mimo rozsahu (viac celočíselných číslic než `maxIntegerDigits`) sa berú
 * rovnako: hodnota sa zahodí namiesto toho, aby databáza pri zápise vyhodila
 * `numeric field value out of range` a zhodila celý import kvôli jednému riadku.
 */
export function parseDecimalComma(
  raw: string,
  maxIntegerDigits: number = MONEY_MAX_INTEGER_DIGITS,
): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const cleaned = trimmed.replace(SEPARATOR_RE, "");
  if (!DECIMAL_RE.test(cleaned)) return null;

  const rounded = roundToTwoDecimals(cleaned.replace(",", "."));
  const unsigned = rounded.startsWith("-") ? rounded.slice(1) : rounded;
  const unsignedDot = unsigned.indexOf(".");
  const integerDigits = (unsignedDot === -1 ? unsigned : unsigned.slice(0, unsignedDot)).length;
  if (integerDigits > maxIntegerDigits) return null;

  return rounded;
}

/** Vráti dátum v tvare YYYY-MM-DD pre `date` stĺpec, alebo null. */
export function parseDate(raw: string): string | null {
  const match = DATE_RE.exec(raw.trim());
  return match?.[1] ?? null;
}
