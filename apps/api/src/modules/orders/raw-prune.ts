import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface PruneRawOrdersOptions {
  readonly keepDays: number;
  readonly now: Date;
}

/**
 * Objednávky (na rozdiel od katalógu) ZÁMERNE nemajú snapshotovú tabuľku
 * (`.claude/rules/orders.md`), takže neexistuje žiadny DB riadok, cez ktorý
 * by sa dala pohnať retencia v štýle katalógovej `pruneRawSnapshots`
 * (`raw-store.ts`) — tá prechádza riadky `catalog_snapshot`, nikdy adresár na
 * disku. Retencia surových exportov objednávok je preto ČISTO súborová:
 * prejde `ORDERS_RAW_DIR` rekurzívne (súbory ležia v `dir/YYYY/MM/*.csv.gz`,
 * `storeRawSnapshot`, zdieľané s katalógom) a zmaže súbory, ktorých mtime je
 * staršie než `keepDays`. Bez sprievodnej DB tabuľky niet ani "posledný
 * prijatý sa nemaže nikdy" výnimky, akú má katalóg — každý súbor sa posudzuje
 * rovnako, len podľa veku.
 */
async function walkFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // Adresár ešte neexistuje (žiadny import ešte nebežal) — to je "nič na
    // zmazanie", nie chyba. Rovnaká disciplína ako katalógov
    // `rm(..., { force: true })`, ktorý ticho prežije aj chýbajúci súbor.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

export async function pruneRawOrders(
  dir: string,
  options: PruneRawOrdersOptions,
): Promise<{ readonly removed: number }> {
  const cutoff = options.now.getTime() - options.keepDays * 24 * 60 * 60 * 1000;
  const files = await walkFiles(dir);

  let removed = 0;
  for (const file of files) {
    const info = await stat(file);
    if (info.mtime.getTime() < cutoff) {
      await rm(file, { force: true });
      removed += 1;
    }
  }
  return { removed };
}
