// Tenký alias pre `pnpm catalog:prune-raw` (tsx, mimo produkčného kontajnera).
// Skutočná logika žije v `apps/api/src/cli/catalog-prune-raw.ts` — TÁ istá
// implementácia sa skompiluje aj do `apps/api/dist/cli/catalog-prune-raw.js`,
// ktorý beží priamo v produkčnom obraze (Docker CMD spúšťa skompilovaný kód,
// nie tsx). Bez tohto by retencia existovala v dvoch kópiách, ktoré by sa
// mohli nenápadne rozísť (final-wave-b, položka 2).
import "../apps/api/src/cli/catalog-prune-raw.js";
