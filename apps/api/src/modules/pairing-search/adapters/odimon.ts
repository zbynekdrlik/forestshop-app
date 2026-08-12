// ODIMON (odimon.sk, BUXUS) — doslovný port `src/parovanie/suppliers/
// odimon.py` zo starej appky (commit 60b6164, issue 387 E2).
//
// odimon.sk vykresľuje výsledky staticky (server-side), ale je cookie-
// gated rovnako ako BETALOV — `client.ts`'s per-host warm-up (BUXUS
// session cookie) musí prebehnúť pred vyhľadávacím requestom (`.claude/
// rules/pairing-search.md`). Každá karta JE priamo `a.product-card`
// (celý odkaz, nie obal okolo neho) — meno produktu nesie `img[alt]`
// (záložne `img[title]`), NIE text kotvy. Scope `.product-list__results`
// vylučuje filtrovacie fasety, mini-košík a karusel „odporúčaných"
// produktov (`.claude/rules/supplier-stock.md` potvrdzuje, že JSON-LD na
// tejto doméne vie klamať — preto sa meno berie z viditeľného `alt`, nie z
// JSON-LD). Žiadny exclusion-prefix zoznam netreba — účtové/košíkové
// odkazy na tomto webe nikdy nenesú triedu `product-card`.
//
// Živo overené 13. 8. 2026 (`fixtures/odimon-vysledky-nohavice.html`,
// `fixtures/odimon-prazdne-vysledky.html`) — selektory aj `.product-
// list__results`/`a.product-card` tvar sa zhodujú so starou appka's
// dokumentáciou z 27. 6. 2026.

import * as cheerio from "cheerio";
import type { PairingCandidate } from "../types.js";
import type { SupplierAdapter } from "./types.js";
import { belongsToBase, resolveAndStripFragment } from "./url.js";

const BASE_URL = "https://www.odimon.sk";

export function parseOdimonSearch(html: string): PairingCandidate[] {
  const $ = cheerio.load(html);
  const results = $(".product-list__results");
  // Rovnaký dôvod ako `betalov.ts`: dve typované vetvy namiesto premennej
  // zmiešaného typu `Cheerio<Element> | Cheerio<Document>`.
  const cards = results.length > 0 ? results.find("a.product-card") : $("a.product-card");

  const out: PairingCandidate[] = [];
  const seen = new Set<string>();

  cards.each((_index, element) => {
    const anchor = $(element);
    const href = (anchor.attr("href") ?? "").trim();
    if (!href) return;

    const url = resolveAndStripFragment(href, `${BASE_URL}/`);
    if (!belongsToBase(url, BASE_URL)) return;
    if (seen.has(url)) return;
    seen.add(url);

    const img = anchor.find("img").first();
    const name = (img.attr("alt") ?? img.attr("title") ?? "").trim();
    out.push({ name, url, code: null, price: null, rawScore: 0, codeHit: false });
  });

  return out;
}

export const odimonAdapter: SupplierAdapter = {
  adapterKey: "odimon",
  baseUrl: BASE_URL,
  buildSearchUrl: (query) => `${BASE_URL}/vysledky-vyhladavania?term=${encodeURIComponent(query)}`,
  parseSearchResults: parseOdimonSearch,
};
