// Registry dodávateľských adaptérov (issue 387 E2) — nahrádza starú
// appka's `client.PARSERS` dict, kľúčovaný podľa `adapterKey` namiesto
// pevného `SUPPLIERS` reťazca (`config.py`). Zámerne oddelené od
// `client.ts`, aby si testy vedeli vybrať konkrétny adaptér bez potreby
// inštanciovať `SearchClient`.

import type { SupplierAdapter } from "./types.js";
import { betalovAdapter } from "./betalov.js";
import { odimonAdapter } from "./odimon.js";
import { wetlandAdapter } from "./wetland.js";

export const SUPPLIER_ADAPTERS: ReadonlyMap<string, SupplierAdapter> = new Map(
  [wetlandAdapter, betalovAdapter, odimonAdapter].map((adapter) => [adapter.adapterKey, adapter]),
);

export function adapterFor(adapterKey: string): SupplierAdapter | undefined {
  return SUPPLIER_ADAPTERS.get(adapterKey);
}
