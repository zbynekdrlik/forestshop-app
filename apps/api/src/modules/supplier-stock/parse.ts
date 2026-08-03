// Čítanie dostupnosti a ceny z HTML stránky dodávateľa — ČISTÉ funkcie, žiadna
// sieť, žiadna databáza. Testuje sa nad uloženými vzorkami stránok.
//
// Tri úrovne v poradí od najspoľahlivejšej:
//   1. JSON-LD `Product` (`schema.org`) — strojový údaj, ktorý dávajú Shoptet,
//      WooCommerce aj PrestaShop; jediný, ktorý hovorí o TOMTO produkte, nie o
//      náhodnom texte na stránke.
//   2. `og:` / `product:` meta značky — ten istý údaj, keď JSON-LD chýba.
//   3. Voľný text stránky — LEN pre domény v `TRUSTED_TEXT_HOSTS`, kde je to
//      overené na vzorke. Inde je dohad horší než „neviem".
//
// Čokoľvek, čo neprejde ani jednou úrovňou, je `unknown` — a `unknown` nikdy
// neprepne produkt (issue 213).

import { TRUSTED_TEXT_HOSTS } from "./constants.js";

export type SupplierAvailability = "available" | "unavailable" | "unknown";
export type SupplierStockSource = "json_ld" | "meta" | "text" | "none";

export interface ParsedPage {
  readonly availability: SupplierAvailability;
  readonly availabilityText: string;
  readonly price: number | null;
  readonly source: SupplierStockSource;
}

/** Doména bez `www.`, malými písmenami. Neplatná URL → prázdny reťazec. */
export function hostOf(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
  return host.startsWith("www.") ? host.slice(4) : host;
}

/** `true`, keď je doména (alebo jej poddoména) medzi overenými pre voľný text. */
export function isTrustedTextHost(url: string): boolean {
  const host = hostOf(url);
  if (host === "") return false;
  return TRUSTED_TEXT_HOSTS.some((trusted) => host === trusted || host.endsWith(`.${trusted}`));
}

// `schema.org` tokeny. Zámerne sa NEBERIE `PreOrder`/`BackOrder` ako
// dostupné: znamenajú "objednáme, príde neskôr", čo pri prepínaní nášho
// produktu na "Skladom" nie je pravda — zákazník by dostal sľub, ktorý
// dodávateľ nedrží.
const SCHEMA_AVAILABLE = new Set(["instock", "limitedavailability", "onlineonly", "instoreonly"]);
const SCHEMA_UNAVAILABLE = new Set([
  "outofstock",
  "soldout",
  "discontinued",
  "preorder",
  "backorder",
]);

/** `schema.org`/`og` token dostupnosti → náš stav. Neznámy token → `unknown`. */
export function availabilityFromSchemaToken(token: string): SupplierAvailability {
  const last = token.split("/").pop() ?? "";
  const normalized = last.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "") return "unknown";
  if (SCHEMA_AVAILABLE.has(normalized)) return "available";
  if (SCHEMA_UNAVAILABLE.has(normalized)) return "unavailable";
  return "unknown";
}

// Vypredané sa kontroluje PRVÉ — stránka, ktorá povie "Vypredané", je
// rozhodná aj keď sa inde na nej vyskytne slovo "skladom" (napr. v odporúčaných
// produktoch). Slovenské, české aj anglické tvary, s diakritikou aj bez nej.
const OUT_KEYWORDS: readonly string[] = Object.freeze([
  "vypredané",
  "vypredane",
  "vypredaný",
  "vypredany",
  "vyprodáno",
  "vyprodano",
  "nedostupné",
  "nedostupne",
  "nedostupný",
  "nedostupny",
  "nie je skladom",
  "není skladem",
  "neni skladem",
  "momentálne nedostupné",
  "momentalne nedostupne",
  "dočasne nedostupné",
  "docasne nedostupne",
  "predaj skončil",
  "predaj skoncil",
  "out of stock",
  "sold out",
]);

const IN_KEYWORDS: readonly string[] = Object.freeze([
  "skladom",
  "na sklade",
  "skladem",
  "ihneď k odberu",
  "ihned k odberu",
  "posledné kusy",
  "posledne kusy",
  "posledný kus",
  "posledny kus",
  "in stock",
]);

/**
 * Dostupnosť z voľného textu. Vypredané vyhráva nad skladom (rozhodný zápor).
 * Vracia aj to, KTORÉ slovo rozhodlo — ide do `availabilityText`, aby bolo
 * v appke vidieť, na základe čoho sa rozhodlo.
 */
export function availabilityFromText(text: string): {
  readonly availability: SupplierAvailability;
  readonly matched: string;
} {
  const lower = text.toLowerCase();
  const out = OUT_KEYWORDS.find((keyword) => lower.includes(keyword));
  if (out !== undefined) return { availability: "unavailable", matched: out };
  const inStock = IN_KEYWORDS.find((keyword) => lower.includes(keyword));
  if (inStock !== undefined) return { availability: "available", matched: inStock };
  return { availability: "unknown", matched: "" };
}

/**
 * Cena z voľného tvaru: „59,90", „59.90", „1 299,00 €", číslo. Keď sú
 * prítomné obe oddeľovacie znamienka, desatinné je to POSLEDNÉ („1.299,00").
 */
export function parsePrice(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  let text = raw.replace(/[^0-9,.-]/g, "");
  if (text === "") return null;
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    text = lastComma > lastDot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (lastComma >= 0) {
    text = text.replace(",", ".");
  }
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
}

/** Odstráni `<script>`/`<style>` a značky — zvyšok je viditeľný text stránky. */
export function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface SchemaHit {
  readonly availability: SupplierAvailability;
  readonly token: string;
  readonly price: number | null;
}

function collectOffers(node: unknown, into: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectOffers(item, into);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const type = record["@type"];
  const isOffer =
    (typeof type === "string" && type.toLowerCase().includes("offer")) ||
    (Array.isArray(type) && type.some((t) => typeof t === "string" && t.toLowerCase().includes("offer")));
  if (isOffer) into.push(record);
  for (const value of Object.values(record)) collectOffers(value, into);
}

/** Dostupnosť + cena z JSON-LD `Product`/`Offer`. Prvá ponuka s údajom vyhráva. */
export function fromJsonLd(html: string): SchemaHit | null {
  const blocks = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const offers: Record<string, unknown>[] = [];
  for (const block of blocks) {
    const body = block[1];
    if (body === undefined) continue;
    try {
      collectOffers(JSON.parse(body), offers);
    } catch {
      // Nevalidný JSON-LD je bežný — jednoducho sa preskočí, nikdy nezhodí beh.
    }
  }
  for (const offer of offers) {
    const raw = offer["availability"];
    if (typeof raw !== "string") continue;
    const availability = availabilityFromSchemaToken(raw);
    if (availability === "unknown") continue;
    return { availability, token: raw, price: parsePrice(offer["price"]) };
  }
  return null;
}

function metaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const direct = pattern.exec(html);
  if (direct?.[1] !== undefined) return direct[1];
  // Poradie atribútov nie je v HTML pevné — `content` môže stáť pred `property`.
  const reversed = new RegExp(
    `<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`,
    "i",
  );
  const flipped = reversed.exec(html);
  return flipped?.[1] ?? null;
}

/** Dostupnosť + cena z `og:`/`product:` meta značiek. */
export function fromMetaTags(html: string): SchemaHit | null {
  // Každý kandidát sa skúsi zvlášť: keď prvá značka nesie token, ktorému
  // nerozumieme, ďalšia ho ešte môže niesť zrozumiteľne — vzdať sa hneď pri
  // prvej by zahodilo použiteľný údaj o pár znakov ďalej.
  for (const property of ["product:availability", "og:availability", "availability"]) {
    const token = metaContent(html, property);
    if (token === null) continue;
    const availability = availabilityFromSchemaToken(token);
    if (availability === "unknown") continue;
    const price =
      parsePrice(metaContent(html, "product:price:amount")) ??
      parsePrice(metaContent(html, "og:price:amount"));
    return { availability, token, price };
  }
  return null;
}

/**
 * Celé čítanie stránky — tri úrovne v poradí. `url` rozhoduje LEN o tom, či sa
 * smie použiť tretia (voľný text): mimo overených domén sa radšej vráti
 * `unknown` než dohad.
 */
export function parsePage(html: string, url: string): ParsedPage {
  const jsonLd = fromJsonLd(html);
  if (jsonLd !== null) {
    return {
      availability: jsonLd.availability,
      availabilityText: jsonLd.token,
      price: jsonLd.price,
      source: "json_ld",
    };
  }

  const meta = fromMetaTags(html);
  if (meta !== null) {
    return {
      availability: meta.availability,
      availabilityText: meta.token,
      price: meta.price,
      source: "meta",
    };
  }

  if (isTrustedTextHost(url)) {
    const text = availabilityFromText(visibleText(html));
    if (text.availability !== "unknown") {
      return {
        availability: text.availability,
        availabilityText: text.matched,
        price: null,
        source: "text",
      };
    }
  }

  return { availability: "unknown", availabilityText: "", price: null, source: "none" };
}
