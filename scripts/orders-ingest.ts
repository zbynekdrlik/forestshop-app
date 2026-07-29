// Tenký alias pre `pnpm orders:ingest` (tsx, mimo produkčného kontajnera).
// Skutočná logika žije v `apps/api/src/cli/orders-ingest.ts` — tá istá
// implementácia sa skompiluje aj do `apps/api/dist/cli/orders-ingest.js`,
// ktorý beží priamo na produkcii (žiadna HTTP trasa/plánovač ešte neexistuje,
// #22/#23), rovnaký vzor ako `scripts/catalog-prune-raw.ts`.
import "../apps/api/src/cli/orders-ingest.js";
