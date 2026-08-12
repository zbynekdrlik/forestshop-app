// Rozhranie pre dodávateľského adaptéra (issue 387 E2) — jeden modul na
// dodávateľa (`wetland.ts`/`betalov.ts`/`odimon.ts`), zaregistrovaný v
// `registry.ts` pod `adapterKey` (rovnaký reťazec ako `supplier.adapter_key`
// stĺpec, `schema-pairing.ts`). `buildSearchUrl`/`parseSearchResults`
// nahrádzajú starú appka's `config.SUPPLIERS`/`client.PARSERS` dvojicu
// (`src/parovanie/config.py`+`suppliers/*.py`) jedným objektom na dodávateľa.

import type { PairingCandidate } from "../types.js";

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
}
