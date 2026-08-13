// issue 402: port starej appky's `parovanie.export_helpers.slug()` +
// `parovanie.url_resolver._tokens()` (https://github.com/zbynekdrlik/
// parovanie_produktov @ HEAD, `src/parovanie/export_helpers.py` +
// `src/parovanie/url_resolver.py`) — DOSLOVNE, jediný rozdiel je JS-ova
// `normalize("NFKD")` namiesto Pythonovho `unicodedata.normalize`
// (rovnaký Unicode algoritmus, obe štandardné knižničné implementácie).

/**
 * forestshop URL slug: NFKD-fold, drop diacritics, non-alnum runs → '-'.
 * `stripLeadingNumber` odreže vedúci "NN " index (`resolve_urls.candidates`
 * to potrebuje pri budovaní kandidátov mimo sitemapy).
 */
export function slug(name: string, stripLeadingNumber = false): string {
  let s = name;
  if (stripLeadingNumber) s = s.replace(/^\d+\s+/, "");
  // `\p{M}` (Unicode "Mark" category) po NFKD dekompozícii pokrýva presne to
  // isté, čo Pythonovo `unicodedata.combining(c) != 0` odstraňuje — po NFKD
  // sa každá diakritika rozpadne na základné písmeno + samostatný combining
  // mark znak.
  const folded = s.normalize("NFKD").replace(/\p{M}/gu, "");
  return folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Meaningful tokens of a slug: drop pure-digit and single-char fragments. */
export function tokens(slugStr: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const t of slugStr.split("-")) {
    if (t !== "" && !/^\d+$/.test(t) && t.length > 1) out.add(t);
  }
  return out;
}
