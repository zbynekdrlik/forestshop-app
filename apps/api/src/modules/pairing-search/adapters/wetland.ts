// WETLAND (wetland.sk, PrestaShop) — doslovný port `src/parovanie/
// suppliers/wetland.py` zo starej appky (commit 60b6164, issue 387 E2).
//
// Primárny selektor: `div.product-miniature__title a.link` — každá karta
// výsledku má tento vnorený odkaz, ktorý nesie AJ meno produktu (text
// uzla), AJ kanonickú URL (href). Záložný selektor
// `a.product-miniature__link` (odkaz na miniatúru obrázku) sa použije,
// LEN keď primárny vráti 0 zhôd — presne ako stará appka (`if not
// anchors: anchors = soup.select(...)`, nie zlúčenie oboch naraz).
// Produktová URL nesie `#/<id>-velkost-<veľkosť>` fragment (predvolená
// veľkosť varianta) — odrezáva sa (`resolveAndStripFragment`) a duplicitné
// URL naprieč viacerými fragmentmi toho istého produktu sa deduplikujú.
//
// Živo overené 13. 8. 2026 (`fixtures/wetland-vysledky-nohavice.html`,
// `fixtures/wetland-prazdne-vysledky.html`) — selektory aj tvar URL sa
// zhodujú so starou appka's dokumentáciou z 27. 6. 2026.

import * as cheerio from "cheerio";
import type { PairingCandidate } from "../types.js";
import type { SupplierAdapter } from "./types.js";
import { belongsToBase, resolveAndStripFragment } from "./url.js";

const BASE_URL = "https://www.wetland.sk";

export function parseWetlandSearch(html: string): PairingCandidate[] {
  const $ = cheerio.load(html);
  const out: PairingCandidate[] = [];
  const seen = new Set<string>();

  let anchors = $("div.product-miniature__title a.link");
  if (anchors.length === 0) {
    anchors = $("a.product-miniature__link");
  }

  anchors.each((_index, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");
    if (!href) return;

    const url = resolveAndStripFragment(href, BASE_URL);
    if (url === null || !belongsToBase(url, BASE_URL)) return;
    if (seen.has(url)) return;
    seen.add(url);

    const name = (anchor.text().trim() || anchor.attr("title") || "").trim();
    out.push({ name, url, code: null, price: null, rawScore: 0, codeHit: false });
  });

  return out;
}

export const wetlandAdapter: SupplierAdapter = {
  adapterKey: "wetland",
  baseUrl: BASE_URL,
  buildSearchUrl: (query) => `${BASE_URL}/vyhladavanie?controller=search&s=${encodeURIComponent(query)}`,
  parseSearchResults: parseWetlandSearch,
};
