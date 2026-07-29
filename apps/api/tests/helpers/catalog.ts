import { catalogSnapshots } from "../../src/db/schema.js";
import type { Database } from "../../src/db/client.js";

export interface TestSnapshot {
  readonly fetchedAt: Date;
  readonly lastConfirmedAt: Date | null;
  readonly sourceLabel: string;
  readonly contentSha256: string;
  readonly byteSize: number;
  readonly rowCount: number;
  readonly columns: string[];
  readonly verdict: "accepted" | "rejected";
  readonly rejectionReason: string | null;
}

/** Vloží snapshot a vráti jeho id — varianty a produkty naň musia mať FK. */
export async function insertTestSnapshot(
  db: Database,
  overrides: Partial<TestSnapshot> = {},
): Promise<string> {
  const [row] = await db
    .insert(catalogSnapshots)
    .values({
      fetchedAt: overrides.fetchedAt ?? new Date("2026-07-29T10:00:00Z"),
      lastConfirmedAt: overrides.lastConfirmedAt ?? overrides.fetchedAt ?? new Date("2026-07-29T10:00:00Z"),
      sourceLabel: overrides.sourceLabel ?? "test",
      // Unikátne pre každé volanie — inak dva testy vkladajúce accepted snapshot
      // bez override narazia na `catalog_snapshot_accepted_sha_uq`, ktorý je
      // navrhnutý presne na to, aby to odhalil (nie testovacia chyba).
      contentSha256: overrides.contentSha256 ?? `sha-test-${crypto.randomUUID()}`,
      byteSize: overrides.byteSize ?? 1_000,
      rowCount: overrides.rowCount ?? 10,
      columns: overrides.columns ?? ["code", "name"],
      verdict: overrides.verdict ?? "accepted",
      rejectionReason: overrides.rejectionReason ?? null,
    })
    .returning({ id: catalogSnapshots.id });
  if (row === undefined) throw new Error("Testovací snapshot sa nepodarilo vložiť");
  return row.id;
}
