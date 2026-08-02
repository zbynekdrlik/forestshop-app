import { alternativeSearchUrl, ALTERNATIVE_SUBJECT, UNAVAILABLE_SUBJECT } from "./constants.js";

// Čistá logika (žiadna DB, žiadna sieť) — texty prevzaté doslovne zo starej
// appky (`nedostupne.py`'s `build_unavailable_email`/`build_alternative_email`,
// majiteľov schválený text, #183 v starej appke) — ticket #176: stará appka je
// referencia na SPRÁVANIE/text, nikdy na vzhľad (`.claude/rules/frontend-
// design.md`). HTML štýl (shell + signatúra) je rovnaký, aký táto appka už
// používa v `order-reminder/logic.ts`'s `buildReminderEmail`.

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface BuiltNedostupneEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

function shell(nameRaw: string, nameH: string, innerHtml: string, innerText: string, signHtml: string, signText: string): { html: string; text: string } {
  const html = [
    "<!DOCTYPE html>",
    "<html>",
    '  <body style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">',
    `    <p>Dobrý deň, <strong>${nameH}</strong>,</p>`,
    "",
    innerHtml,
    '    <p style="margin-top: 30px;">',
    `      ${signHtml}`,
    "    </p>",
    "  </body>",
    "</html>",
  ].join("\n");
  const text = [`Dobrý deň, ${nameRaw},`, "", innerText, "", signText].join("\n");
  return { html, text };
}

const SIGN_DRLIK_HTML = 'S pozdravom,<br>\n      <strong>Drlík, Forestshop.sk</strong><br>\n      <a href="https://www.forestshop.sk" target="_blank">www.forestshop.sk</a>';
const SIGN_DRLIK_TEXT = "S pozdravom, Drlík, Forestshop.sk";
const SIGN_DEFAULT_HTML = 'S pozdravom,<br>\n      <strong>Tím Forestshop.sk</strong><br>\n      <a href="https://www.forestshop.sk" target="_blank">www.forestshop.sk</a>';
const SIGN_DEFAULT_TEXT = "S pozdravom, Tím Forestshop.sk";

/** E-mail bez návrhu náhrady — majiteľov schválený generický text (stará
 * appka #183): zámerne NEuvádza konkrétny názov produktu. */
export function buildUnavailableEmail(customerName: string): BuiltNedostupneEmail {
  const nameRaw = (customerName || "").trim() || "zákazník";
  const nameH = htmlEscape(nameRaw);
  const innerHtml =
    "    <p>veľmi sa ospravedlňujeme, ale tovar ktorý ste si objednali je momentálne " +
    "nedostupný a nevieme kedy bude naskladnený. Z toho dôvodu nevieme Vašu objednávku " +
    "úspešne vybaviť.</p>\n";
  const innerText =
    "veľmi sa ospravedlňujeme, ale tovar ktorý ste si objednali je momentálne nedostupný " +
    "a nevieme kedy bude naskladnený. Z toho dôvodu nevieme Vašu objednávku úspešne vybaviť.";
  const { html, text } = shell(nameRaw, nameH, innerHtml, innerText, SIGN_DRLIK_HTML, SIGN_DRLIK_TEXT);
  return { subject: UNAVAILABLE_SUBJECT, html, text };
}

export interface EmailAlternative {
  readonly code: string;
  readonly name: string;
  readonly url: string;
}

/** Vytvorí zoznam náhradných produktov z RAW kódov (`product.related_codes`)
 * + rozlíšeného mena (`namesByCode` — vopred vyriešené DB dopytom,
 * `queries.ts`'s `resolveAlternativeNames`). Neznámy kód (nikdy nevidený
 * variant/pairCode) padá späť na SEBA SAMÉHO ako meno — rovnaký zámer ako
 * stará appka's `code2name.get(rc, rc)`, nikdy sa nezahadzuje. URL je vždy
 * klikateľný vyhľadávací fallback (`alternativeSearchUrl`, `constants.ts`).*/
export function buildAlternatives(codes: readonly string[], namesByCode: ReadonlyMap<string, string>): readonly EmailAlternative[] {
  return codes.map((code) => ({ code, name: namesByCode.get(code) ?? code, url: alternativeSearchUrl(code) }));
}

/** E-mail s návrhom náhrady — produkt je nedostupný + priamo priradené
 * alternatívy (relatedProduct*), rovnaký zámer ako stará appka's
 * `build_alternative_email`. */
export function buildAlternativeEmail(customerName: string, itemName: string, alternatives: readonly EmailAlternative[]): BuiltNedostupneEmail {
  const nameRaw = (customerName || "").trim() || "zákazník";
  const nameH = htmlEscape(nameRaw);
  const prodH = htmlEscape((itemName || "").trim() || "objednaný tovar");
  const prodText = (itemName || "").trim() || "objednaný tovar";

  const itemsHtml = alternatives
    .map((a) => {
      const altNameH = htmlEscape(a.name.trim() || a.code);
      const hrefH = htmlEscape(a.url);
      return `      <li><a href="${hrefH}" target="_blank">${altNameH}</a></li>`;
    })
    .join("\n");
  const altBlockHtml =
    alternatives.length > 0
      ? `    <p>Radi by sme vám preto ponúkli tieto <strong>alternatívne produkty</strong>:</p>\n    <ul>\n${itemsHtml}\n    </ul>\n`
      : "    <p>Radi vám pomôžeme nájsť vhodnú alternatívu — stačí nás kontaktovať.</p>\n";
  const altBlockText =
    alternatives.length > 0
      ? `Alternatívne produkty:\n${alternatives.map((a) => `- ${a.name.trim() || a.code} (${a.url})`).join("\n")}`
      : "Radi vám pomôžeme nájsť vhodnú alternatívu — stačí nás kontaktovať.";

  const innerHtml =
    `    <p>Radi by sme vás informovali, že produkt <strong>${prodH}</strong> z vašej objednávky je momentálne <strong>nedostupný</strong>.</p>\n\n` +
    `${altBlockHtml}\n` +
    '    <p>Ak máte akékoľvek otázky, pokojne nás kontaktujte na <a href="mailto:eshop@forestshop.sk">eshop@forestshop.sk</a> alebo na telefónnom čísle <a href="tel:+421903670766">+421 903 670 766</a>.</p>\n\n' +
    "    <p>Ďakujeme vám za dôveru.</p>\n";
  const innerText =
    `Radi by sme vás informovali, že produkt ${prodText} z vašej objednávky je momentálne nedostupný.\n\n` +
    `${altBlockText}\n\n` +
    "Kontakt: eshop@forestshop.sk, +421 903 670 766.\n\n" +
    "Ďakujeme vám za dôveru.";

  const { html, text } = shell(nameRaw, nameH, innerHtml, innerText, SIGN_DEFAULT_HTML, SIGN_DEFAULT_TEXT);
  return { subject: ALTERNATIVE_SUBJECT, html, text };
}
