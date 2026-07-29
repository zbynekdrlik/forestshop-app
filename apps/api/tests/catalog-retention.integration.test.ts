import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { catalogSnapshots } from "../src/db/schema.js";
import { pruneRawSnapshots, storeRawSnapshot } from "../src/modules/catalog/raw-store.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

let close: (() => Promise<void>) | undefined;
let dir: string | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const NOW = new Date("2026-07-29T10:00:00Z");
const DAVNO = new Date("2026-05-01T10:00:00Z");
const VCERA = new Date("2026-07-28T10:00:00Z");

async function existuje(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Snapshot sa vloží aj s cestou k svojmu surovému súboru — `insertTestSnapshot`
 *  `raw_path` nenastavuje, doplní sa hneď po vložení. */
async function snapshotSoSuborom(
  db: Awaited<ReturnType<typeof withCleanDb>>["db"],
  input: {
    readonly dir: string;
    readonly at: Date;
    readonly sha: string;
    readonly verdict: "accepted" | "rejected";
  },
): Promise<{ id: string; path: string }> {
  const path = await storeRawSnapshot(input.dir, {
    at: input.at,
    sha256: input.sha,
    body: Buffer.from(input.sha),
  });
  const id = await insertTestSnapshot(db, {
    fetchedAt: input.at,
    contentSha256: input.sha,
    verdict: input.verdict,
    rejectionReason:
      input.verdict === "rejected" ? "Stiahnutý súbor je prázdny (0 bajtov)." : null,
  });
  await db.update(catalogSnapshots).set({ rawPath: path }).where(eq(catalogSnapshots.id, id));
  return { id, path };
}

it("zmaže surové súbory prijatých snapshotov starších než 30 dní", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  dir = await mkdtemp(join(tmpdir(), "forestshop-prune-"));

  const stary = await snapshotSoSuborom(ctx.db, { dir, at: DAVNO, sha: "a".repeat(64), verdict: "accepted" });
  const novy = await snapshotSoSuborom(ctx.db, { dir, at: VCERA, sha: "b".repeat(64), verdict: "accepted" });
  const odmietnuty = await snapshotSoSuborom(ctx.db, { dir, at: DAVNO, sha: "c".repeat(64), verdict: "rejected" });

  const result = await pruneRawSnapshots(ctx.db, { keepDays: 30, now: NOW });

  expect(result.removed).toBe(1);
  expect(await existuje(stary.path)).toBe(false);
  // Nedávny prijatý zostáva, odmietnutý zostáva navždy (je to dôkaz, nie odpad).
  expect(await existuje(novy.path)).toBe(true);
  expect(await existuje(odmietnuty.path)).toBe(true);

  const rows = await ctx.db.select().from(catalogSnapshots).orderBy(desc(catalogSnapshots.fetchedAt));
  // Riadky snapshotov sa NIKDY nemažú — mizne len cesta k zmazanému súboru.
  expect(rows).toHaveLength(3);
  expect(rows.find((r) => r.contentSha256 === "a".repeat(64))?.rawPath).toBeNull();
});

it("nikdy nezmaže surový súbor posledného prijatého snapshotu", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  dir = await mkdtemp(join(tmpdir(), "forestshop-prune-"));

  const jediny = await snapshotSoSuborom(ctx.db, { dir, at: DAVNO, sha: "d".repeat(64), verdict: "accepted" });

  expect(await pruneRawSnapshots(ctx.db, { keepDays: 30, now: NOW })).toEqual({ removed: 0 });
  expect(await existuje(jediny.path)).toBe(true);
});
