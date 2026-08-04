// Rozoberač feedu pre porovnávače (issue 220).
//
// Zdroj je Shoptetom generovaný Google Merchant feed `https://www.forestshop.sk/
// google.xml` — jediný verejný zdroj, ktorý má naraz NÁŠ kód variantu a PRIAMU
// adresu detailu produktu. CSV export adresu nemá vôbec a `guid` je UUID, takže
// adresa sa z uložených dát poskladať nedá (overené pri issue 217).
//
// Zámerne BEZ novej závislosti na XML parseri: tvar feedu je plochý a pevný
// (`<entry>` s textovými deťmi `<g:id>` a `<link>`), takže regulárny výraz nad
// jednou položkou stačí a nepridáva do obrazu ďalší balík. Keby feed niekedy
// začal niesť vnorenú štruktúru, toto miesto je jediné, ktoré treba vymeniť.

export interface ShopFeedEntry {
  readonly code: string;
  readonly url: string;
  // Shoptetova VLASTNÁ dostupnosť (issue 226) — surový text ("in stock"/
  // "out of stock"), `null` keď je `<g:availability>` prázdna ALEBO chýba
  // celkom. Chýbajúci signál sa NIKDY nezamieňa s prázdnym reťazcom — obe
  // musia byť rovnako "žiadny rozpor", nikdy porovnateľná hodnota.
  readonly availability: string | null;
}

const ENTRY = /<entry>([\s\S]*?)<\/entry>/g;
const CODE = /<g:id>([\s\S]*?)<\/g:id>/;
// Zámerne `<link>` s koncovou značkou — hlavička feedu má `<link href="…" />`
// (samostatne uzavretý, adresa vzorového webu), ktorý sa takto nikdy nechytí.
const URL_TAG = /<link>([\s\S]*?)<\/link>/;
const AVAILABILITY_TAG = /<g:availability>([\s\S]*?)<\/g:availability>/;

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decode(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity).trim();
}

/**
 * Vráti dvojice `kód → adresa` v poradí, v akom sú vo feede.
 *
 * Položka bez kódu alebo bez adresy sa PRESKOČÍ — do mapy sa nikdy nedostane
 * poloprázdny riadok, ktorý by na obrazovke vyrobil odkaz nikam. Pri
 * duplicitnom kóde platí PRVÝ výskyt: feed je generovaný po variantoch a
 * neskorší duplikát je vždy menej špecifický záznam (bez `variantId`).
 */
export function parseShopFeed(xml: string): readonly ShopFeedEntry[] {
  const seen = new Set<string>();
  const rows: ShopFeedEntry[] = [];

  for (const [, entry] of xml.matchAll(ENTRY)) {
    if (entry === undefined) continue;
    const code = decode(CODE.exec(entry)?.[1] ?? "");
    const url = decode(URL_TAG.exec(entry)?.[1] ?? "");
    if (code === "" || url === "") continue;
    if (seen.has(code)) continue;
    seen.add(code);
    const rawAvailability = decode(AVAILABILITY_TAG.exec(entry)?.[1] ?? "");
    rows.push({ code, url, availability: rawAvailability === "" ? null : rawAvailability });
  }

  return rows;
}
