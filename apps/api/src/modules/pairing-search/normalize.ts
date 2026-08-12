// Doslovný port `src/parovanie/normalize.py` zo starej appky (commit
// 60b6164, issue 387 E1 — návrh https://github.com/zbynekdrlik/
// forestshop-app/issues/387#issuecomment-5273377438, sekcia „Čo sa
// portuje 1:1"). Žiadna sieť, žiadna DB — čisté funkcie.

// Kolaps akéhokoľvek behu whitespace na jednu medzeru (rovnaké ako Python's
// `re.sub(r"\s+", " ", ...)`).
const WHITESPACE_RUN = /\s+/g;

// Vedúci číselný index poradia zo Shoptet exportu ("01 Ponožky BOBR" →
// "Ponožky BOBR") — presne `normalize.py`'s `_LEADING_INDEX =
// re.compile(r"^\d{1,3}\s+(?=\D)")`. 1-3 číslice + medzery + lookahead na
// NE-číslicu (aby sa nikdy neodrezal skutočný číselný kód na začiatku mena).
const LEADING_INDEX = /^\d{1,3}\s+(?=\D)/;

/**
 * `clean_name(s)` zo starej appky: orež okrajové whitespace, zlúč vnútorné
 * behy whitespace na jednu medzeru, odstráň vedúci číselný index poradia.
 * Poradie krokov (strip → collapse → strip index → strip) je zámerne
 * zachované rovnaké ako v Pythone.
 */
export function cleanName(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  const collapsed = trimmed.replace(WHITESPACE_RUN, " ");
  const withoutIndex = collapsed.replace(LEADING_INDEX, "");
  return withoutIndex.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `code_present(code, hay)` zo starej appky: True, keď sa `code` vyskytuje v
 * `hay` ako CELÝ alfanumerický token — nie ako podreťazec dlhšieho behu.
 * Takže "110" sedí v "model 110 x", ale NIE v "...1100". Case-insensitive.
 * Chráni pred krátkymi/číselnými dodávateľskými kódmi falošne zhodujúcimi
 * nesúvisiace produkty (čo by zapísalo zlú URL na doobjednanie).
 */
export function codePresent(code: string | null | undefined, hay: string | null | undefined): boolean {
  if (!code) return false;
  const pattern = new RegExp(`(?<![0-9a-z])${escapeRegExp(code.toLowerCase())}(?![0-9a-z])`);
  return pattern.test((hay ?? "").toLowerCase());
}
