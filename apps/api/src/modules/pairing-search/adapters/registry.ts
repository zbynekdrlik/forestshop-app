// Registry dodávateľských adaptérov (issue 387 E2) — nahrádza starú
// appka's `client.PARSERS` dict, kľúčovaný podľa `adapterKey` namiesto
// pevného `SUPPLIERS` reťazca (`config.py`). Zámerne oddelené od
// `client.ts`, aby si testy vedeli vybrať konkrétny adaptér bez potreby
// inštanciovať `SearchClient`.

import type { SupplierAdapter } from "./types.js";
import { belongsToBase } from "./url.js";
import { betalovAdapter } from "./betalov.js";
import { odimonAdapter } from "./odimon.js";
import { wetlandAdapter } from "./wetland.js";

const ADAPTER_LIST: readonly SupplierAdapter[] = [wetlandAdapter, betalovAdapter, odimonAdapter];

export const SUPPLIER_ADAPTERS: ReadonlyMap<string, SupplierAdapter> = new Map(
  ADAPTER_LIST.map((adapter) => [adapter.adapterKey, adapter]),
);

export function adapterFor(adapterKey: string): SupplierAdapter | undefined {
  return SUPPLIER_ADAPTERS.get(adapterKey);
}

/**
 * issue 422 — nájde adaptéra podľa HOSTA danej URL (na rozdiel od
 * `adapterFor`, ktoré ide podľa `adapterKey` reťazca). Používa
 * `belongsToBase` (rovnaká príslušnosť-k-doméne logika ako adaptéry
 * samotné pri parsovaní výsledkov). `undefined` = URL nepatrí žiadnemu z
 * troch známych dodávateľov (napr. ručne zadaná linka od iného
 * dodávateľa) — volajúci (`live-detail-info.ts`) to rieši ako "žiadne
 * živé info", nikdy sa nehádže.
 */
export function adapterForUrl(url: string): SupplierAdapter | undefined {
  return ADAPTER_LIST.find((adapter) => belongsToBase(url, adapter.baseUrl));
}
