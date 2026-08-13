// Tenký alias pre `pnpm pairing:backfill-images` (tsx, mimo produkčného
// kontajnera). Skutočná logika žije v `apps/api/src/cli/pairing-backfill-
// images.ts` — TÁ istá implementácia sa skompiluje aj do `apps/api/dist/
// cli/pairing-backfill-images.js`, ktorý beží priamo v produkčnom obraze
// (Docker CMD spúšťa skompilovaný kód, nie tsx). Rovnaký vzor ako
// `scripts/catalog-prune-raw.ts`.
import "../apps/api/src/cli/pairing-backfill-images.js";
