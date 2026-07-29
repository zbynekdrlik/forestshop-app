import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

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
