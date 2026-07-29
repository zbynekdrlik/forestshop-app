import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Čiastočný mock — `stat` je jediná exportovaná funkcia, ktorú tento súbor
// potrebuje ovládať (simulácia rasovej podmienky "súbor zmizol MEDZI
// readdir a stat"). Priamy `vi.spyOn(fsPromises, "stat")` na natívnom ESM
// module zlyhá ("Module namespace is not configurable in ESM") — `vi.mock`
// s `importOriginal` je jediný spôsob, ako v ESM prostredí nahradiť JEDEN
// export a ostatné (`readdir`/`rm`) nechať skutočné.
const { stat: mockedStat } = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  mockedStat.mockImplementation(actual.stat);
  return { ...actual, stat: mockedStat };
});

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

it("súbor, ktorý zmizne MEDZI readdir a stat (súbežné mazanie mimo appky), sa ticho preskočí — nepadne celý beh (review finding)", async () => {
  dir = await mkdtemp(join(tmpdir(), "forestshop-orders-prune-"));
  const prvy = join(dir, "prvy.csv.gz");
  const druhy = join(dir, "druhy.csv.gz");
  await writeFile(prvy, "a");
  await writeFile(druhy, "b");
  await utimes(prvy, DAVNO, DAVNO);
  await utimes(druhy, DAVNO, DAVNO);

  const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
  enoent.code = "ENOENT";
  // `mockImplementationOnce` zasiahne PRVÉ volanie `stat` bez ohľadu na to, v
  // akom poradí `readdir` súbory vráti (POSIX to negarantuje) — test je preto
  // zámerne nezávislý od toho, ktorý z dvoch súborov "zmizne".
  mockedStat.mockImplementationOnce(() => Promise.reject(enoent));

  const result = await pruneRawOrders(dir, { keepDays: 30, now: NOW });
  // Presne JEDEN súbor sa naozaj zmazal (ten, čo prešiel `stat` normálne) —
  // beh nesmie spadnúť na tom, ktorý "zmizol", ani ho omylom nepočítať.
  expect(result).toEqual({ removed: 1 });
  const presneJedenOstal = (await existuje(prvy)) !== (await existuje(druhy));
  expect(presneJedenOstal).toBe(true);
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
