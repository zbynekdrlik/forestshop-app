// Reťazenie restocku za supplier-stock — issue 561 (follow-up #552).
// Dva nezávislé nočné rozvrhy (supplier-stock 04:20, restock 04:50) prestali
// od #552 (enumerácia) dávať zmysel: celý beh > 2 h, takže restock o 04:50
// bežal nad dátami zo včera. Prístup 1(b): `supplierStockJob(run, afterRun?)`
// zavolá `afterRun` PO úspechu (nie po zlyhaní), `index.ts` cez `afterRun`
// spustí restock cez existujúci `startRunNow`. Zdieľaná brána `decideRestockRun`
// rešpektuje `isRestockEnabled` + chýbajúce údaje presne ako pôvodný
// `restockJob.run` (jedna logika, nie dve kópie). Čistý unit (bez DB) —
// `afterRun`/`run` sú špióni, `isRestockEnabled` je mocknuté.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../db/client.js";
import { SUPPLIER_STOCK_JOB_NAME } from "../supplier-stock/constants.js";

vi.mock("../restock/run.js", () => ({ isRestockEnabled: vi.fn() }));
import { isRestockEnabled } from "../restock/run.js";
import {
  RESTOCK_DISABLED_REASON,
  RESTOCK_MISSING_CREDENTIALS_MESSAGE,
  decideRestockRun,
  supplierStockJob,
  type RunRestock,
  type RunSupplierStock,
} from "./jobs.js";

const DB = {} as Database;
const NOW = new Date("2026-09-20T02:20:00Z");

const okRun: RunSupplierStock = () =>
  Promise.resolve({
    total: 0,
    skipped: 0,
    checked: 0,
    available: 0,
    unavailable: 0,
    unknown: 0,
    failed: 0,
    hosts: [],
    hostStats: [],
  });

describe("supplierStockJob — issue 561: afterRun sa volá PO úspechu, nie po zlyhaní", () => {
  it("po ÚSPEŠNOM behu zavolá afterRun s (db, now) a vráti detail behu", async () => {
    const afterRun = vi.fn(() => Promise.resolve());
    const job = supplierStockJob(okRun, afterRun);
    expect(job.name).toBe(SUPPLIER_STOCK_JOB_NAME);

    const outcome = await job.run(DB, NOW);
    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(afterRun).toHaveBeenCalledWith(DB, NOW);
    expect(outcome.detail).toMatchObject({ checked: 0 });
  });

  it("keď beh ZLYHÁ (run vyhodí), afterRun sa NEVOLÁ a job.run vyhodí ďalej (scheduler zapíše failure)", async () => {
    const afterRun = vi.fn(() => Promise.resolve());
    const failingRun: RunSupplierStock = () => Promise.reject(new Error("scraper zlyhal"));
    const job = supplierStockJob(failingRun, afterRun);

    await expect(job.run(DB, NOW)).rejects.toThrow("scraper zlyhal");
    expect(afterRun).not.toHaveBeenCalled();
  });

  it("chyba v afterRun sa LOGUJE, ale NEZHODÍ supplier-stock beh (riadok už je čo je)", async () => {
    const afterRun = vi.fn(() => Promise.reject(new Error("restock reťaz zlyhala")));
    const job = supplierStockJob(okRun, afterRun);

    const outcome = await job.run(DB, NOW);
    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(outcome.detail).toMatchObject({ checked: 0 });
  });

  it("bez afterRun (spätná kompatibilita) sa správa ako predtým — vráti detail", async () => {
    const job = supplierStockJob(okRun);
    const outcome = await job.run(DB, NOW);
    expect(outcome.detail).toMatchObject({ checked: 0 });
  });
});

describe("decideRestockRun — issue 561: zdieľaná brána (enabled + chýbajúce údaje)", () => {
  beforeEach(() => {
    vi.mocked(isRestockEnabled).mockReset();
  });

  it("vypnuté (Štart/Stop) → skip so štandardným dôvodom (bez ohľadu na údaje)", async () => {
    vi.mocked(isRestockEnabled).mockResolvedValue(false);
    const decision = await decideRestockRun(DB, undefined);
    expect(decision).toEqual({ action: "skip", detail: { skipped: true, reason: RESTOCK_DISABLED_REASON } });
  });

  it("zapnuté, ale chýbajú Shoptet údaje (run undefined) → vyhodí rovnako ako pôvodný restockJob", async () => {
    vi.mocked(isRestockEnabled).mockResolvedValue(true);
    await expect(decideRestockRun(DB, undefined)).rejects.toThrow(RESTOCK_MISSING_CREDENTIALS_MESSAGE);
  });

  it("zapnuté a údaje sú → action 'run' s odovzdaným run", async () => {
    vi.mocked(isRestockEnabled).mockResolvedValue(true);
    const run: RunRestock = () => Promise.resolve({ status: "nothing_to_do", overLimit: 0 });
    const decision = await decideRestockRun(DB, run);
    expect(decision).toEqual({ action: "run", run });
  });
});
