// Zdieľané URL pomôcky pre dodávateľské parsery (issue 387 E2) — port
// starej appka's `urllib.parse.urljoin`+`urldefrag` dvojice (`suppliers/
// {wetland,betalov,odimon}.py`) na natívne WHATWG `URL`. Všetky tri
// parsery potrebujú TO ISTÉ: spojiť relatívny/absolútny `href` s koreňom
// dodávateľa, odrezať `#fragment` (produktová URL na wetland.sk nesie
// `#/variant-velkost`, ktorý sa do kandidáta nemá dostať), a overiť, že
// výsledná URL naozaj patrí danému dodávateľovi (chráni pred externým
// odkazom vo výsledkovej karte).

/**
 * Spojí `href` s `baseUrl` (WHATWG `URL` rezolúcia — rovnaké správanie ako
 * Python's `urljoin` pre tieto tvary vstupu) a odrezáva `#fragment`
 * (`urldefrag`). Vyhadzuje pri nespracovateľnej URL — volajúci parser to
 * necháva prejsť ako chybu tohto konkrétneho výsledku, nie tichú stratu.
 */
export function resolveAndStripFragment(href: string, baseUrl: string): string {
  const url = new URL(href, baseUrl);
  url.hash = "";
  return url.toString();
}

/** `true`, keď `url` patrí do `baseUrl`'s domény (port starej appka's
 *  `url.startswith(base_url)` reťazcovej kontroly). */
export function belongsToBase(url: string, baseUrl: string): boolean {
  return url.startsWith(baseUrl);
}
