// Zmaže uložené surové exporty prijatých snapshotov staršie než 30 dní:
//   DATABASE_URL=… pnpm catalog:prune-raw
import { createDb } from "../apps/api/src/db/client.js";
import { loadEnv } from "../apps/api/src/env.js";
import { pruneRawSnapshots } from "../apps/api/src/modules/catalog/raw-store.js";

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
