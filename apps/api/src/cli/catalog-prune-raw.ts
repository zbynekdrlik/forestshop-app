// Zmaže uložené surové exporty prijatých snapshotov staršie než 30 dní. Toto je
// KANONICKÁ implementácia — `scripts/catalog-prune-raw.ts` (spúšťané cez
// `pnpm catalog:prune-raw`, tsx, mimo produkčného kontajnera) je len jej tenký
// alias. Tento súbor žije PRIAMO v `apps/api/src`, takže ho `pnpm --filter
// @forestshop/api build` (tsc -b) skompiluje do `apps/api/dist/cli/
// catalog-prune-raw.js` — Dockerfile už kopíruje celý `apps/api/dist` do
// produkčného obrazu, takže žiadna zmena Dockerfile nie je potrebná. Retencia
// nemá HTTP trasu (na rozdiel od importu, ktorý beží aj cez tlačidlo na webe) —
// bez tohto by na produkčnom hostiteľovi neexistoval SPÔSOB, ako ju vôbec
// spustiť (final-wave-b, položka 2): obraz nemal `scripts/`, hostiteľ mal
// `scripts/` bez `node_modules`, takže surový zväzok rástol donekonečna.
//
// Príkaz na produkcii (viď `.claude/rules/deploy.md`):
//   docker compose -f docker-compose.prod.yml exec app node apps/api/dist/cli/catalog-prune-raw.js
import { createDb } from "../db/client.js";
import { loadEnv } from "../env.js";
import { pruneRawSnapshots } from "../modules/catalog/raw-store.js";

const KEEP_DAYS = 30;

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
let result: { readonly removed: number };
try {
  result = await pruneRawSnapshots(db, { keepDays: KEEP_DAYS, now: new Date() });
} finally {
  await pool.end();
}

console.log(`Zmazaných surových súborov: ${String(result.removed)} (staršie než ${String(KEEP_DAYS)} dní).`);
console.log(JSON.stringify(result));
