import { CATEGORY_CONTACTED, CATEGORY_NOT_CONTACTED, EMAIL_SUBJECT, MIN_DAYS } from "./constants.js";

// Čistá logika (žiadna DB, žiadna sieť) — verný port `orders_reminder.py`,
// prispôsobený tak, aby čítal priamo z `order` riadkov (nie z CSV export),
// viď návrhový komentár na issue 173.

export interface ReminderEligibleOrder {
  readonly externalOrderId: string;
  readonly placedAt: Date;
  readonly statusName: string;
  readonly shopRemark: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly customerName: string;
  readonly shoptetOrderId: number | null;
}

/** Objednávka, za ktorú je táto automatizácia zodpovedná — v jednom z
 * nastavených "otvorených" stavov (ten istý zoznam ako "Na objednanie",
 * `listOpenStatusNames`), BEZ vekového filtra (ten sa aplikuje samostatne
 * cez `daysOpen`/`MIN_DAYS`, rovnaký zámer ako #172's rozdelenie
 * eligible/shipments). Slúži AJ ako "okno", proti ktorému sa
 * `order_reminder_state` čistí — objednávka, čo opustí otvorené stavy
 * (vybavená/stornovaná), stráca svoj záznam pri ďalšom behu. */
export function isEligibleOrder(order: { readonly statusName: string }, openStatuses: ReadonlySet<string>): boolean {
  return openStatuses.has(order.statusName);
}

/** Celé dni od `placedAt` po `today` — nikdy záporné (budúci dátum sa berie
 * ako 0, nikdy nevyhodí). */
export function daysOpen(placedAt: Date, today: Date): number {
  return Math.max(0, Math.floor((today.getTime() - placedAt.getTime()) / 86_400_000));
}

export function isOldEnough(placedAt: Date, today: Date, minDays: number = MIN_DAYS): boolean {
  return daysOpen(placedAt, today) >= minDays;
}

/** Stabilný odtlačok polí, ktoré rozhodujú o AI/e-mailovom výsledku (#153 v
 * starej appke — inkrementálne spracovanie) — `placedAt` + `shopRemark`.
 * Počet dní je ZÁMERNE vynechaný: postupuje každý deň aj pre nedotknutú
 * objednávku, takže by defeat-ol inkrementalitu (ticket: "počet dní sa
 * zámerne NEZAPOČÍTAVA do kontroly zmeny objednávky"). */
export function fingerprint(order: { readonly placedAt: Date; readonly shopRemark: string | null }): string {
  return `${order.placedAt.toISOString()}|${order.shopRemark ?? ""}`;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface BuiltReminderEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** (subject, html, text) — doslovný preklad `orders_reminder.py`'s
 * `build_reminder_email` (n8n "Edit Fields2" šablóna), voľný text (meno, kód)
 * HTML-escapovaný. JEDEN e-mail, žiadne stupňovanie podľa poradia (na rozdiel
 * od #172's `buildEmail(count, ...)`). */
export function buildReminderEmail(customerName: string, orderCode: string): BuiltReminderEmail {
  const nameH = htmlEscape(customerName);
  const codeH = htmlEscape(orderCode);
  const html = [
    "<!DOCTYPE html>",
    "<html>",
    '  <body style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">',
    `    <p>Dobrý deň, <strong>${nameH}</strong>,</p>`,
    "",
    `    <p>Všimli sme si, že spracovanie vašej objednávky č. <strong>${codeH}</strong> trvá o niečo dlhšie než obvykle. Chceme vás ubezpečiť, že situáciu aktívne sledujeme a riešime.</p>`,
    "",
    "    <p>Mierne zdržanie môže byť spôsobené dostupnosťou tovaru, dopĺňaním zásob alebo prepravnými okolnosťami. Rozumieme, že sa na svoju výbavu tešíte, a robíme všetko pre to, aby ste ju mali čo najskôr pri sebe.</p>",
    "",
    '    <p>👉 V prípade potreby zmeny, alternatívy alebo potvrdenia z vašej strany vás budeme osobne kontaktovať v najbližšom čase.</p>',
    "",
    '    <p>Ďakujeme vám za trpezlivosť a dôveru. Ak máte akékoľvek otázky, pokojne nás kontaktujte na <a href="mailto:eshop@forestshop.sk">eshop@forestshop.sk</a> alebo na telefónnom čísle <a href="tel:+421903670766">+421 903 670 766</a>.</p>',
    "",
    '    <p style="margin-top: 30px;">',
    "      S pozdravom,<br>",
    "      <strong>Tím Forestshop.sk</strong><br>",
    '      <a href="https://www.forestshop.sk" target="_blank">www.forestshop.sk</a>',
    "    </p>",
    "  </body>",
    "</html>",
  ].join("\n");

  const text = [
    `Dobrý deň, ${customerName},`,
    "",
    `Všimli sme si, že spracovanie vašej objednávky č. ${orderCode} trvá o niečo dlhšie než obvykle. Chceme vás ubezpečiť, že situáciu aktívne sledujeme a riešime.`,
    "",
    "Mierne zdržanie môže byť spôsobené dostupnosťou tovaru, dopĺňaním zásob alebo prepravnými okolnosťami.",
    "",
    "V prípade potreby zmeny, alternatívy alebo potvrdenia z vašej strany vás budeme osobne kontaktovať v najbližšom čase.",
    "",
    "Ďakujeme vám za trpezlivosť a dôveru. Kontakt: eshop@forestshop.sk, +421 903 670 766.",
    "",
    "S pozdravom, Tím Forestshop.sk",
  ].join("\n");

  return { subject: EMAIL_SUBJECT, html, text };
}

export interface ClassifierMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

/** OpenAI chat messages pre klasifikáciu internej poznámky predajne — verný
 * port `orders_reminder.py`'s `build_classifier_messages`. Prázdna poznámka
 * → "BEZ POZNAMKY" (zhoda s n8n inputText fallback) — čistý stavový automat
 * túto vetvu nikdy nevolá (bez poznámky = len červené upozornenie), toto
 * ostáva len obranné. */
export function buildClassifierMessages(shopRemark: string | null): readonly ClassifierMessage[] {
  const note = (shopRemark ?? "").trim() || "BEZ POZNAMKY";
  const system = `Si klasifikátor interných poznámok predajne k objednávke. Rozhoduješ, či zákazník UŽ BOL kontaktovaný ohľadom svojej objednávky.

Kategória "${CATEGORY_CONTACTED}": zákazník UŽ BOL kontaktovaný/informovaný. Dokazuje to DOKONČENÝ telefonát v minulom čase (napr. "volané so zákazníkom/zákazníčkou", "dovolal som sa", "hovoril som so zákazníkom"), najmä ak nasleduje dohoda ("počká", "bude sa čakať", "po dohode so zákazníkom"), ALEBO už odoslaná SMS ("poslaná sms", "sms poslaná"). Sem patrí aj "volané ... počká".

Kategória "${CATEGORY_NOT_CONTACTED}": zákazník ešte NEBOL úspešne kontaktovaný. Patrí sem: prázdna poznámka / "BEZ POZNAMKY"; len interné poznámky o tovare ("nemáme", "objednané", "nedostupné", "chýba kus"); BUDÚCI zámer zavolať ešte nesplnený ("volať zákazníka", "budeme volať", "treba volať", "ja vybavím"); a IBA NEÚSPEŠNÝ pokus o telefonát bez SMS ("nedovolal som sa", "nezdvíha"). Tu sa posiela pripomienkový e-mail.

KĽÚČOVÝ ROZDIEL: "volané" = telefonát sa UŽ uskutočnil (kontaktovaný), ale "volať" / "budeme volať" / "treba volať" = ešte sa NEvolalo (nekontaktovaný). Neodôvodňuj, vráť IBA JSON objekt v tvare {"kategoria": "${CATEGORY_CONTACTED}"} alebo {"kategoria": "${CATEGORY_NOT_CONTACTED}"}.`;
  const user = `Interná poznámka:\n${note}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Parsuje odpoveď modelu → `true` keď zákazník bol UŽ kontaktovaný (e-mail sa
 * neposiela), `false` keď NEbol (posiela sa pripomienka). Tolerantné voči
 * ```json plotu aj holému reťazcu kategórie. Vyhodí na nerozpoznanú
 * odpoveď — volajúci to zaznamená ako chybu, NIKDY nehádaj. */
export function parseClassification(content: string): boolean {
  let s = content.trim();
  if (s.startsWith("```")) {
    s = s
      .replace(/^```[a-zA-Z]*\s*/, "")
      .replace(/\s*```$/, "")
      .trim();
  }
  let kategoria = "";
  try {
    const parsed: unknown = JSON.parse(s);
    if (typeof parsed === "string") {
      kategoria = parsed.trim().toLowerCase();
    } else if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as { readonly kategoria?: unknown; readonly category?: unknown };
      const raw = obj.kategoria ?? obj.category ?? "";
      kategoria = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    }
  } catch {
    kategoria = s.trim().replace(/^"|"$/g, "").toLowerCase();
  }
  if (kategoria === CATEGORY_CONTACTED) return true;
  if (kategoria === CATEGORY_NOT_CONTACTED) return false;
  throw new Error(`klasifikátor nevrátil platnú kategóriu: ${content}`);
}
