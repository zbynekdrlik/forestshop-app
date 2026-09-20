// Reťazený restock za supplier-stock — issue 561 (follow-up #552).
// `buildRestockAfterSupplierStock` je `afterRun` hák, ktorý `index.ts` zavesí
// na `supplierStockJob`; spustí restock cez existujúci `startRunNow` (ten istý
// neblokujúci mechanizmus ako tlačidlo "Spustiť teraz": vlastný `job_run`
// riadok, `pg_try_advisory_lock`). Rešpektuje `isRestockEnabled` a reťazený beh
// nesie `trigger: "after-supplier-stock"`. Integračný (reálna DB) — overuje
// zápis `job_run` riadku aj detailu; `startRunNow` beží fire-and-forget, takže
// čakáme na konečný stav cez `waitForJobRunSettled`.
import { afterEach, describe, expect, it } from "vitest";
import { RESTOCK_JOB_NAME } from "../src/modules/restock/constants.js";
import { setRestockEnabled } from "../src/modules/restock/run.js";
import {
  RESTOCK_DISABLED_REASON,
  RESTOCK_TRIGGER_AFTER_SUPPLIER_STOCK,
  buildRestockAfterSupplierStock,
  type RunRestock,
} from "../src/modules/scheduler/jobs.js";
import { withCleanDb } from "./helpers/db.js";
import { waitForJobRunSettled } from "./helpers/job-run.js";

const NOW = new Date("2026-09-20T02:24:00Z");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("buildRestockAfterSupplierStock — issue 561: reťazenie restocku za supplier-stock", () => {
  it("restock VYPNUTÝ (enabled=false) → zapíše 'restock' job_run riadok so skipped detailom + trigger, run sa NEVOLÁ", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    // Default = žiadny riadok = vypnuté (fail-closed). Beh sa nikdy nespustí.
    let runCalled = false;
    const run: RunRestock = () => {
      runCalled = true;
      return Promise.resolve({ status: "nothing_to_do", overLimit: 0 });
    };

    const afterRun = buildRestockAfterSupplierStock(run);
    await afterRun(ctx.db, NOW);

    const finalRun = await waitForJobRunSettled(ctx.db, RESTOCK_JOB_NAME);
    expect(finalRun.status).toBe("success");
    expect(finalRun.detail).toEqual({
      skipped: true,
      reason: RESTOCK_DISABLED_REASON,
      trigger: RESTOCK_TRIGGER_AFTER_SUPPLIER_STOCK,
    });
    expect(runCalled).toBe(false);
  });

  it("restock ZAPNUTÝ (enabled=true) → spustí run a zapíše 'restock' job_run riadok s výsledkom + trigger", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    await setRestockEnabled(ctx.db, true, NOW);

    let receivedNow: Date | undefined;
    const run: RunRestock = (_db, now) => {
      receivedNow = now;
      return Promise.resolve({ status: "nothing_to_do", overLimit: 0 });
    };

    const afterRun = buildRestockAfterSupplierStock(run);
    await afterRun(ctx.db, NOW);

    const finalRun = await waitForJobRunSettled(ctx.db, RESTOCK_JOB_NAME);
    expect(finalRun.status).toBe("success");
    expect(finalRun.detail).toEqual({
      status: "nothing_to_do",
      overLimit: 0,
      trigger: RESTOCK_TRIGGER_AFTER_SUPPLIER_STOCK,
    });
    expect(receivedNow?.toISOString()).toBe(NOW.toISOString());
  });
});
