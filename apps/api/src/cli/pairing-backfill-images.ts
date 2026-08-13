// Backfill obrázka CHOSEN kandidáta pre `pairing_candidate` riadky bez neho
// (issue 397) — kanonická implementácia, presne vzor `cli/catalog-prune-
// raw.ts`. Tento súbor žije PRIAMO v `apps/api/src`, takže ho `pnpm
// --filter @forestshop/api build` (tsc -b) skompiluje do
// `apps/api/dist/cli/pairing-backfill-images.js` — Dockerfile už kopíruje
// celý `apps/api/dist` do produkčného obrazu, takže žiadna zmena
// Dockerfile nie je potrebná. `scripts/pairing-backfill-images.ts` je len
// jej tenký re-export alias pre lokálne/CI spustenie (`pnpm pairing:
// backfill-images`).
//
// IDEMPOTENTNÝ — bezpečné spustiť KEDYKOĽVEK znova (dotkne sa len riadkov,
// čo ešte nemajú obrázok). Berie `PAIRING_SEARCH_RUN_LOCK_KEY` (rovnaký
// zámok ako nočný gather beh), takže sa NIKDY nesmie/nemôže pretínať s
// ním — spúšťaj mimo očakávaného behu nočného jobu, ak chceš, aby doňho
// backfill sám nečakal.
//
// Príkaz na produkcii (viď `.claude/rules/deploy.md`):
//   docker compose -f docker-compose.prod.yml exec app node apps/api/dist/cli/pairing-backfill-images.js
import { createDb } from "../db/client.js";
import { loadEnv } from "../env.js";
import { backfillCandidateImages } from "../modules/pairing-search/backfill.js";

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
let result: Awaited<ReturnType<typeof backfillCandidateImages>>;
try {
  result = await backfillCandidateImages({ db });
} finally {
  await pool.end();
}

console.log(
  `Obrázok kandidáta doplnený pre ${String(result.updated)} z ${String(result.checked)} skontrolovaných (${String(result.failed)} zlyhaní).`,
);
console.log(JSON.stringify(result));
