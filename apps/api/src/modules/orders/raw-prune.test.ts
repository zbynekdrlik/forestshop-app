import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pruneRawOrders } from "./raw-prune.js";

const NOW = new Date("2026-07-30T10:00:00Z");
const DAVNO = new Date("2026-05-01T10:00:00Z");
const VCERA = new Date("2026-07-29T10:00:00Z");

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function existuje(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

it("zmaže len súbory staršie než keepDays (podľa mtime), nedávne nechá", async () => {
  dir = await mkdtemp(join(tmpdir(), "forestshop-orders-prune-"));
  const stary = join(dir, "stary.csv.gz");
  const novy = join(dir, "novy.csv.gz");
  await writeFile(stary, "a");
  await writeFile(novy, "b");
  await utimes(stary, DAVNO, DAVNO);
  await utimes(novy, VCERA, VCERA);

  const result = await pruneRawOrders(dir, { keepDays: 30, now: NOW });

  expect(result).toEqual({ removed: 1 });
  expect(await existuje(stary)).toBe(false);
  expect(await existuje(novy)).toBe(true);
});

it("prejde adresár rekurzívne — súbory v podadresároch YYYY/MM (storeRawSnapshot) sa tiež posúdia", async () => {
  dir = await mkdtemp(join(tmpdir(), "forestshop-orders-prune-"));
  const subdir = join(dir, "2026", "05");
  await mkdir(subdir, { recursive: true });
  const staryVHlbke = join(subdir, "stary.csv.gz");
  await writeFile(staryVHlbke, "a");
  await utimes(staryVHlbke, DAVNO, DAVNO);

  const result = await pruneRawOrders(dir, { keepDays: 30, now: NOW });

  expect(result).toEqual({ removed: 1 });
  expect(await existuje(staryVHlbke)).toBe(false);
});

it("chýbajúci adresár (žiadny import ešte nebežal) sa berie ako 'nič na zmazanie', nie chyba", async () => {
  const neexistujuci = join(tmpdir(), `forestshop-orders-prune-neexistuje-${String(Date.now())}`);
  await expect(pruneRawOrders(neexistujuci, { keepDays: 30, now: NOW })).resolves.toEqual({ removed: 0 });
});

it("súbor presne na hranici keepDays (mtime rovný cutoffu) sa nezmaže — hranica je ostro 'starší než', nie 'starý alebo rovný'", async () => {
  dir = await mkdtemp(join(tmpdir(), "forestshop-orders-prune-"));
  const naHranici = join(dir, "na-hranici.csv.gz");
  await writeFile(naHranici, "a");
  const cutoff = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
  await utimes(naHranici, cutoff, cutoff);

  const result = await pruneRawOrders(dir, { keepDays: 30, now: NOW });

  expect(result).toEqual({ removed: 0 });
  expect(await existuje(naHranici)).toBe(true);
});
