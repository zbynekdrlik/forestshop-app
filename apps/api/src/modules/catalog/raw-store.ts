import { and, desc, eq, isNotNull, lt } from "drizzle-orm";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { Database } from "../../db/client.js";
import { catalogSnapshots } from "../../db/schema.js";

const gzipAsync = promisify(gzip);

export interface RawSnapshotInput {
  readonly at: Date;
  readonly sha256: string;
  readonly body: Buffer;
}

/**
 * 54 MB exportu nepatrí do Postgresu — v databáze je len cesta a sha256, surové
 * bajty ležia gzipnuté na disku. Odvodený katalóg je celý v databáze, takže ho
 * pokrýva nočný `pg_dump`; surové súbory sú dôkazový materiál, nie zdroj pravdy.
 */
export async function storeRawSnapshot(dir: string, input: RawSnapshotInput): Promise<string> {
  const stamp = input.at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const subdir = join(dir, stamp.slice(0, 4), stamp.slice(4, 6));
  await mkdir(subdir, { recursive: true });
  const path = join(subdir, `${stamp}-${input.sha256.slice(0, 12)}.csv.gz`);
  await writeFile(path, await gzipAsync(input.body));
  return path;
}

export interface PruneOptions {
  readonly keepDays: number;
  readonly now: Date;
}

/**
 * Retencia sa týka LEN uložených surových súborov, nikdy riadkov v databáze —
 * varianty na snapshoty odkazujú cez FK „naposledy videný v". Prijaté snapshoty
 * staršie než `keepDays` prídu o súbor (odvodený katalóg je v Postgrese a kryje ho
 * `pg_dump`), odmietnuté si súbor nechávajú navždy — je to dôkaz, prečo boli odmietnuté.
 * Súbor posledného prijatého snapshotu sa nezmaže nikdy, ani keď je starší.
 */
export async function pruneRawSnapshots(
  db: Database,
  options: PruneOptions,
): Promise<{ readonly removed: number }> {
  const cutoff = new Date(options.now.getTime() - options.keepDays * 24 * 60 * 60 * 1000);

  const [newest] = await db
    .select({ id: catalogSnapshots.id })
    .from(catalogSnapshots)
    .where(eq(catalogSnapshots.verdict, "accepted"))
    .orderBy(desc(catalogSnapshots.fetchedAt))
    .limit(1);

  const rows = await db
    .select({ id: catalogSnapshots.id, rawPath: catalogSnapshots.rawPath })
    .from(catalogSnapshots)
    .where(
      and(
        eq(catalogSnapshots.verdict, "accepted"),
        lt(catalogSnapshots.fetchedAt, cutoff),
        isNotNull(catalogSnapshots.rawPath),
      ),
    );

  let removed = 0;
  for (const row of rows) {
    if (row.rawPath === null || row.id === newest?.id) continue;
    await rm(row.rawPath, { force: true });
    await db
      .update(catalogSnapshots)
      .set({ rawPath: null })
      .where(eq(catalogSnapshots.id, row.id));
    removed += 1;
  }
  return { removed };
}
