// Rozhranie pre dodávateľského adaptéra (issue 387 E2) — jeden modul na
// dodávateľa (`wetland.ts`/`betalov.ts`/`odimon.ts`), zaregistrovaný v
// `registry.ts` pod `adapterKey` (rovnaký reťazec ako `supplier.adapter_key`
// stĺpec, `schema-pairing.ts`). `buildSearchUrl`/`parseSearchResults`
// nahrádzajú starú appka's `config.SUPPLIERS`/`client.PARSERS` dvojicu
// (`src/parovanie/config.py`+`suppliers/*.py`) jedným objektom na dodávateľa.

import type { PairingCandidate } from "../types.js";

// issue 422 — živá cena + dostupnosť KANDIDÁTA/rozhodnutia z jeho DETAILNEJ
// stránky (na rozdiel od `parseSearchResults`, ktorý parsuje VÝSLEDKOVÚ
// stránku). `null`/`null` = žiadny zdroj neposkytol použiteľnú hodnotu —
// nikdy sa nehádže, best-effort presne ako stará appka's `_supplier_meta`.
export interface SupplierDetailMeta {
  /** Formátované na 2 desatinné miesta (`"149.90"`), mena je vždy EUR
   *  (živo overené na všetkých troch dodávateľoch, design komentár na
   *  tickete #422) — frontend pridáva `€` rovnako, ako to robí stará appka. */
  readonly price: string | null;
  /** Ľudsky čitateľný slovenský text ("Skladom"/"Nedostupné"), nikdy surový
   *  schema.org token. */
  readonly availabilityText: string | null;
}

export interface SupplierAdapter {
  /** Zhoduje sa s `supplier.adapter_key` v DB (pripravené na E3). */
  readonly adapterKey: string;
  /** Koreň dodávateľského webu, napr. `"https://www.wetland.sk"` — bez
   *  koncovej lomky, presne ako stará appka's `SupplierConfig.base_url`. */
  readonly baseUrl: string;
  /** Zostaví absolútnu URL vyhľadávacej stránky pre danú (nekódovanú) query. */
  buildSearchUrl(query: string): string;
  /**
   * Vyparsuje HTML vyhľadávacej stránky na kandidátov. `code`/`price` sú
   * VŽDY `null` — stará appka ich pri parsovaní výsledkov tiež nikdy
   * nenapĺňala (`models.Candidate(name, url)`, defaulty `code=None,
   * price=None`); dopĺňajú sa až pri overení kódu na detaile produktu
   * (`verify.py`, mimo rozsahu E2 — plánované na E4). `rawScore`/`codeHit`
   * sú neutrálne (`0`/`false`) — `ranking.ts`'s `rank()` ich vždy prepíše
   * vlastným výpočtom, nikdy nečíta vstupnú hodnotu.
   */
  parseSearchResults(html: string): readonly PairingCandidate[];
  /** issue 422 — živá cena+dostupnosť z DETAILNEJ stránky (`SearchClient
   *  .fetchPage`'s výstup). KAŽDÝ dodávateľ potrebuje VLASTNÚ extrakciu —
   *  živo overené (design komentár #422), že WETLAND/ODIMON majú JSON-LD
   *  `Offer` (zdieľaný helper, `detail-meta.ts`), zatiaľ čo BETALOV
   *  (huntingshop.eu) nemá ŽIADNE JSON-LD/meta a jeho CSS triedy sa
   *  opakujú v karuseli súvisiacich produktov — vlastná extrakcia. */
  extractDetailMeta(html: string): SupplierDetailMeta;
}
