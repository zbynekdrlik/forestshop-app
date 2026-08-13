// Kódové overenie vybraného kandidáta (issue 387 E4) — doslovný port
// `src/parovanie/verify.py`'s title+code časti `extract_page` +
// `code_verdict` zo starej appky (commit 60b6164). Design komentár na
// tickete (sekcia "Čo sa adaptuje"): price sa NEPORTUJE (meta kandidáta sa
// znovupoužije zo `supplier-stock` v E5) — "verify.ts pridáva len kódovú
// kaskádu". Stará appka volala tieto funkcie z externého AI-verifikačného
// kroku, ktorý sa tu neportuje (design, sekcia 5, posledný odsek) — táto
// appka repurpose-uje presnú kaskádu ako AUTOMATICKÝ OK/UNSURE gate nad
// `pick_best()`'s `chosen_url` (`run.ts`).
//
// **Kaskáda na kód** (pôvodná, `verify.py`):
// 1. PrestaShop (wetland): `.detail__title` element, ktorého text obsahuje
//    "kód" → najbližší predok `<li>` (alebo `div[class*=detail]` fallback)
//    → jeho `.detail__right` text.
// 2. Nette (betalov/huntingshop.eu): `.fs-5` element, regex
//    `(?:katalógové číslo|kód|sku)\s*[:\-]?\s*(.+)`.
// 3. Generický fallback: `[itemprop="sku"]`/`.product-code`/`.sku`/`.kod`/
//    `[data-code]` — `content`/`data-code` atribút alebo text.
//
// **Odchýlka od doslovného portu (živo overené 13. 8. 2026, design komentár
// "Rozhodnutie k ODIMON"):** stará appka nemala vlastný ODIMON selektor
// (žiadna fixtúra, generický fallback na živej stránke nič netrafí).
// Krok 2b nižšie (`.product-property-item`) je NOVÝ, pridaný medzi Nette a
// generický fallback — bez neho by ODIMON kandidáti VŽDY skončili na
// `unsure` (bezpečné, ale zbytočne slabé pokrytie tretiny dodávateľov).
//
// issue 397: `image` — `og:image` z TEJ ISTEJ detailnej HTML, čo táto
// funkcia aj tak sťahuje na kódovú kaskádu (ŽIADEN extra request). Použité
// v `run.ts` LEN ako fallback, keď adaptér vlastný obrázok z výsledkovej
// karty nenašiel — filtrovaný cez `resolveImageUrl`'s šumový zoznam
// (`adapters/url.ts`), lebo BETALOV's `og:image` je na tejto doméne VŽDY
// stránkové logo (živo overené, design komentár na tickete).

import * as cheerio from "cheerio";
import { resolveImageUrl } from "./adapters/url.js";
import { codePresent } from "./normalize.js";
import type { SearchClient } from "./client.js";
import type { PairingProduct, PairingVerdict } from "./types.js";
import { log } from "../../logger.js";

/** Výstup kódovej kaskády — port `extract_page`'s title+code polí (price sa
 *  neportuje, viď komentár vyššie) + `image` (issue 397, mimo portu). */
export interface PageExtract {
  readonly title: string;
  readonly code: string | null;
  readonly image: string | null;
}

export interface VerifyOutcome {
  readonly verdict: PairingVerdict;
  readonly reason: string;
  /** issue 397 — `og:image` fallback z tej istej stránky, `null` keď
   *  chýba/je šumový (`resolveImageUrl`). Volajúci (`run.ts`) ho použije
   *  LEN keď adaptér vlastný obrázok kandidáta nenašiel. */
  readonly imageUrl: string | null;
}

const WHITESPACE_RUN = /\s+/g;

function collapseWhitespace(value: string): string {
  return value.replace(WHITESPACE_RUN, " ").trim();
}

/** Port `extract_page`'s title vetva: `<h1>` text, inak `<title>` so
 *  stripnutým "| Site"/" - Site" chvostom, inak prázdny reťazec. */
function extractTitle($: cheerio.CheerioAPI): string {
  const h1 = $("h1").first();
  if (h1.length > 0) return h1.text();

  const titleTag = $("title").first();
  if (titleTag.length === 0) return "";
  const raw = titleTag.text().trim();
  if (!raw.includes("|") && !raw.includes(" - ")) return raw;
  // Python: `raw.split("|")[0].split(" - ")[0].strip()` — OBE rozdelenia sa
  // aplikujú sekvenčne, keď je prítomný ASPOŇ jeden z oddeľovačov.
  const afterPipe = raw.split("|")[0] ?? raw;
  return afterPipe.split(" - ")[0] ?? afterPipe;
}

/** 1. PrestaShop (wetland): `.detail__title` obsahujúce "kód" → najbližší
 *  `<li>` predok (alebo `div[class*=detail]` fallback) → `.detail__right`. */
function extractPrestaShopCode($: cheerio.CheerioAPI): string | null {
  let code: string | null = null;
  $(".detail__title").each((_index, element) => {
    const label = $(element);
    if (!label.text().trim().toLowerCase().includes("kód")) return undefined;
    const li = label.closest("li");
    const row = li.length > 0 ? li : label.closest('div[class*="detail"]');
    if (row.length > 0) {
      const right = row.find(".detail__right").first();
      if (right.length > 0) {
        const text = right.text().trim();
        code = text.length > 0 ? text : null;
      }
    }
    return false; // port Python's `break` — zastaví sa na PRVOM zhodnom labeli
  });
  return code;
}

const NETTE_CODE_RE = /(?:katalógové číslo|kód|sku)\s*[:-]?\s*(.+)/i;

/** 2. Nette (betalov/huntingshop.eu): `.fs-5` regex "Katalógové číslo: X". */
function extractNetteCode($: cheerio.CheerioAPI): string | null {
  for (const element of $(".fs-5").toArray()) {
    const text = $(element).text().trim();
    const match = NETTE_CODE_RE.exec(text);
    if (match) {
      const captured = (match[1] ?? "").trim();
      return captured.length > 0 ? captured : null;
    }
  }
  return null;
}

/** 2b. ODIMON (BUXUS) — NOVÝ krok, mimo doslovného portu (viď komentár na
 *  vrchu súboru): `.product-property-item` so `.product-property__title`
 *  obsahujúcim "kód" → `.product-property__value`. */
function extractOdimonCode($: cheerio.CheerioAPI): string | null {
  for (const element of $(".product-property-item").toArray()) {
    const item = $(element);
    const label = item.find(".product-property__title").first().text().trim().toLowerCase();
    if (!label.includes("kód")) continue;
    const value = item.find(".product-property__value").first().text().trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

const GENERIC_CODE_SELECTORS = ['[itemprop="sku"]', ".product-code", ".sku", ".kod", "[data-code]"] as const;

/** 3. Generický fallback: `content`/`data-code` atribút, inak text. Port
 *  Python's `el.get("content") or el.get("data-code") or el.get_text(...)`
 *  — `or` padá na ĎALŠÍ zdroj aj pri PRÁZDNOM (nie len chýbajúcom) reťazci,
 *  preto `||` (nie `??`, review nález issue 387 E4: `??` by pri prázdnom
 *  `content=""` zastavilo na ňom namiesto skúsenia `data-code`/textu). */
function extractGenericCode($: cheerio.CheerioAPI): string | null {
  for (const selector of GENERIC_CODE_SELECTORS) {
    const el = $(selector).first();
    if (el.length === 0) continue;
    const value = (el.attr("content") || el.attr("data-code") || el.text()).trim();
    if (value.length > 0) return value;
  }
  return null;
}

function extractCode($: cheerio.CheerioAPI): string | null {
  return (
    extractPrestaShopCode($) ?? extractNetteCode($) ?? extractOdimonCode($) ?? extractGenericCode($) ?? null
  );
}

/**
 * issue 397 (mimo doslovného portu): `<meta property="og:image">` —
 * jediný obrázkový zdroj tohto fallbacku (dispatch: "fallback og:image z
 * detailu", nikdy celá stará appka's gallery-selektorová kaskáda —
 * `adaptéry` už dnes reálne dávajú obrázok priamo z výsledkovej karty pre
 * všetkých troch dodávateľov, toto je len defenzívna posledná záchrana).
 * `resolveImageUrl` (zdieľané s adaptérmi) rieši relatívny `content` voči
 * `detailUrl` A filtruje šumové obrázky (logo/placeholder/…) — bez tohto
 * by BETALOV's stránkové logo (`og:image` je tam VŽDY logo, živo overené)
 * skončilo ako "obrázok kandidáta".
 */
function extractOgImage($: cheerio.CheerioAPI, detailUrl: string): string | null {
  const content = $('meta[property="og:image"]').first().attr("content");
  return resolveImageUrl([content], detailUrl);
}

/** Port `extract_page` (title+code časť — price sa neportuje) + `image`
 *  (issue 397). `detailUrl` je stránka, z ktorej `html` pochádza —
 *  potrebná na rezolúciu relatívnej `og:image` URL (`resolveImageUrl`). */
export function extractPage(html: string, detailUrl: string): PageExtract {
  const $ = cheerio.load(html);
  return { title: collapseWhitespace(extractTitle($)), code: extractCode($), image: extractOgImage($, detailUrl) };
}

/**
 * Port `code_verdict` — adaptované na VIAC external kódov (jeden per
 * variant, rovnaký vzor ako `ranking.ts`'s `isCodeHit`): zhoda platí, keď
 * SA HOCIKTORÝ z `product.externalCodes` nájde v title+code haystacku.
 * Produkt bez žiadneho external kódu je VŽDY `unsure` — nikdy `ok` bez
 * dôkazu (dispatch akceptačné kritérium E4).
 */
export function codeVerdict(product: PairingProduct, page: PageExtract): VerifyOutcome {
  if (product.externalCodes.length === 0) {
    return { verdict: "unsure", reason: "produkt nemá žiadny external kód na overenie", imageUrl: page.image };
  }
  const hay = [page.title, page.code ?? ""].filter((part) => part.length > 0).join(" ");
  const matchedCode = product.externalCodes.find((code) => codePresent(code, hay));
  if (matchedCode !== undefined) {
    return { verdict: "ok", reason: `kód ${matchedCode} sa nachádza na stránke kandidáta`, imageUrl: page.image };
  }
  return {
    verdict: "unsure",
    reason: `žiadny z kódov produktu (${product.externalCodes.join(", ")}) sa na stránke kandidáta nenašiel`,
    imageUrl: page.image,
  };
}

/**
 * Stiahne detailnú stránku kandidáta cez `SearchClient.fetchPage` (zdieľaný
 * fetcher — session cookie jar + throttle-if-real, rovnaký ako `.search()`)
 * a vráti kódový verdikt. Sieťová/parse chyba sa NIKDY nevyhodí ďalej —
 * zachytáva sa a vracia `unsure` s dôvodom, aby zlyhanie overenia nezhodilo
 * celý per-produkt gather cyklus (`run.ts`).
 */
export async function verifyCandidateCode(
  client: SearchClient,
  url: string,
  product: PairingProduct,
): Promise<VerifyOutcome> {
  if (product.externalCodes.length === 0) {
    // Žiadny fetch (šetrí requesty, nezmenené E4 správanie) — teda ani
    // žiadna šanca na `og:image` fallback, `imageUrl` ostáva `null`.
    return { verdict: "unsure", reason: "produkt nemá žiadny external kód na overenie", imageUrl: null };
  }
  // Sieťová ANI parse chyba sa nikdy nevyhodí ďalej — obe (fetch aj
  // extractPage/codeVerdict) sú v JEDNOM try, aby zlyhanie overenia nikdy
  // nezhodilo celý per-produkt gather cyklus (`run.ts`), presne ako
  // dokstring sľubuje (review nález issue 387 E4: pôvodná verzia chránila
  // len fetch, nie parsovanie).
  try {
    const html = await client.fetchPage(url);
    return codeVerdict(product, extractPage(html, url));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ url, message }, "pairing-search: verify zlyhal, verdikt unsure");
    return { verdict: "unsure", reason: `overenie kandidáta zlyhalo (${message})`, imageUrl: null };
  }
}
