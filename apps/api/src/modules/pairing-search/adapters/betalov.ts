// BETALOV (huntingshop.eu, Nette) — doslovný port `src/parovanie/
// suppliers/betalov.py` zo starej appky (commit 60b6164, issue 387 E2).
//
// huntingshop.eu vykresľuje výsledky vyhľadávania cez Nette AJAX snippet
// (`#snippet--productList`) — BEZ platnej relácie (`client.ts`'s per-host
// warm-up) je tento kontajner prázdny (`.claude/rules/pairing-search.md`).
// Kontajner nesie DVA tab-pane (`#home` = mriežka, `#profile` = zoznam) so
// SAMOSTATNÝMI CSS triedami na kartu (`.product-col` vs. `.product-card`
// bez `product-col`) — parser scopuje na `#snippet--productList` a vyberá
// LEN `.product-col` karty (mriežkový pohľad), presne ako stará appka
// (`scope.select(".product-col")`); zoznamový pohľad sa tak nikdy
// neparsuje dvakrát.
//
// Na KAŽDEJ karte sa najprv skúsi náhľadový odkaz `a.mh-100` (má vedúcu
// lomku, teda dobre tvarovaný), a až keď chýba, padá sa na `.product-title
// a` (BEZ vedúcej lomky na tomto webe). `_EXCLUDE_PREFIXES` je doslovný
// port navigačných/účtových ciest, ktoré by sa inak (teoreticky) dostali
// do výsledkového kontajnera. Dedup podľa kanonickej URL.
//
// Živo overené 13. 8. 2026 (`fixtures/betalov-vysledky-nohavice.html`,
// `fixtures/betalov-prazdne-vysledky.html`) — selektory aj `#snippet--
// productList`/`.product-col` tvar sa zhodujú so starou appka's
// dokumentáciou z 27. 6. 2026.

import * as cheerio from "cheerio";
import type { PairingCandidate } from "../types.js";
import type { SupplierAdapter } from "./types.js";
import { belongsToBase, resolveAndStripFragment } from "./url.js";

const BASE_URL = "https://www.huntingshop.eu";

// Doslovný port `suppliers/betalov.py`'s `_EXCLUDE_PREFIXES` — navigačné/
// účtové/utilitné cesty tejto Nette appky, nikdy produktové karty.
const EXCLUDE_PREFIXES = [
  "/kosik",
  "/prihlasenie",
  "/registracia",
  "/kontakt",
  "/hladanie",
  "/obchodne",
  "/ochrana",
  "/blog",
  "/clanok",
  "/kategoria",
  "/znacka",
  "/akcia",
  "/akcie",
  "/novinky",
  "/assets",
  "/assets2",
  "/upload",
  "/vyrobca",
] as const;

export function parseBetalovSearch(html: string): PairingCandidate[] {
  const $ = cheerio.load(html);
  const snippet = $("#snippet--productList");
  // `$.root()` je typu `Cheerio<Document>` (nie `Cheerio<Element>`) — radšej
  // dve samostatne typované vetvy (`.find()` v scope / `$(selector)` na
  // celom dokumente) než premenná zmiešaného typu, ktorej `.find()` by TS
  // odmietol (`noUncheckedIndexedAccess`/`strictTypeChecked` nesúhlasí s
  // `this` typu `Cheerio<Element> | Cheerio<Document>`).
  const cards = snippet.length > 0 ? snippet.find(".product-col") : $(".product-col");

  const out: PairingCandidate[] = [];
  const seen = new Set<string>();

  cards.each((_index, element) => {
    const card = $(element);

    let href = card.find("a.mh-100").first().attr("href") ?? "";
    if (!href) {
      href = card.find(".product-title a").first().attr("href") ?? "";
    }
    if (!href) return;

    // Port `urljoin(base_url + "/", href.lstrip("/"))` — obe formy (vedúca
    // lomka aj bez nej) sa normalizujú na rovnaký absolútny tvar.
    const url = resolveAndStripFragment(href.replace(/^\/+/, ""), `${BASE_URL}/`);
    if (!belongsToBase(url, BASE_URL)) return;

    const path = url.slice(BASE_URL.length);
    if (EXCLUDE_PREFIXES.some((prefix) => path.startsWith(prefix))) return;

    if (seen.has(url)) return;
    seen.add(url);

    const name = card.find(".product-title a").first().text().trim();
    out.push({ name, url, code: null, price: null, rawScore: 0, codeHit: false });
  });

  return out;
}

export const betalovAdapter: SupplierAdapter = {
  adapterKey: "betalov",
  baseUrl: BASE_URL,
  buildSearchUrl: (query) => `${BASE_URL}/hladanie?search=${encodeURIComponent(query)}`,
  parseSearchResults: parseBetalovSearch,
};
