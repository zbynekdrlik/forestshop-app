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
 * (`urldefrag`). Vráti `null` pri nespracovateľnej URL namiesto vyhodenia
 * — WHATWG `URL` je (na rozdiel od Pythonovho zhovievavého `urljoin`/
 * `urldefrag`) PRÍSNY parser (živo overené: `new URL("http://exam
 * ple.com/x", …)` aj `new URL("http://[", …)` obe vyhadzujú), takže
 * vyhodenie z tejto funkcie by pri jednej pokazenej karte zhodilo CELÝ
 * `.each()` cyklus volajúceho parsera a zahodilo aj VŠETKY ostatné, platné
 * kandidáty na tej istej stránke (review nález, issue 387 E2) — presne
 * tomu má "chyba len tohto výsledku" hlavičkový komentár tejto funkcie
 * zabrániť, `null` návrat to zaručuje priamo v type systéme namiesto
 * spoliehania sa na to, že si to KAŽDÝ volajúci nezabudne obaliť.
 */
export function resolveAndStripFragment(href: string, baseUrl: string): string | null {
  try {
    const url = new URL(href, baseUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * `true`, keď `url` patrí do `baseUrl`'s domény — port starej appka's
 * `url.startswith(base_url)` kontroly, ALE s hranicou znaku (review nález,
 * issue 387 E2): holé `startsWith` by pustilo aj `https://www.wetland.sk.
 * evil.example/x` proti `baseUrl="https://www.wetland.sk"`. `baseUrl` je
 * tu vždy natvrdo zapísaná konštanta adaptéra (nikdy vstup od útočníka),
 * takže ide o obranu do hĺbky, nie o opravu skutočne zneužiteľnej diery.
 */
export function belongsToBase(url: string, baseUrl: string): boolean {
  return url === baseUrl || url.startsWith(`${baseUrl}/`);
}
