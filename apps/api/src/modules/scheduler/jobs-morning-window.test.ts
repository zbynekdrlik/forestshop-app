// issue 598 (ROZHODNUTÉ 16. 11. 2026, možnosť 2): Shoptet každé ráno približne
// 04:05–08:15 blokuje IP servera. Denné joby, ktoré chodia na forestshop.sk
// (sitemap, restock — zápis do administrácie) alebo reťazia restock (supplier-
// stock → `afterRun`), nesmú štartovať v okne 04:00–08:30 miestneho času.
// supplier-stock sám chodí len na weby dodávateľov, no po ~1,5–2 h behu
// reťazí restock — preto musí štartovať tak skoro, aby reťaz dobehla pred 04:00.
import { describe, expect, it } from "vitest";
import type { DailySchedule, ScheduledJob } from "./types.js";
import * as jobs from "./jobs.js";
import { restockJob, supplierStockJob } from "./jobs.js";

const WINDOW_START_MIN = 4 * 60;
const WINDOW_END_MIN = 8 * 60 + 30;

function startMinute(job: ScheduledJob): number {
  expect(job.schedule.kind).toBe("daily");
  const s = job.schedule as DailySchedule;
  return s.hourLocal * 60 + s.minuteLocal;
}

const noop = () => Promise.reject(new Error("nevolá sa"));

describe("issue 598: ranné okno bloku Shoptetu (04:00–08:30)", () => {
  it("restock štartuje až po 08:30", () => {
    expect(startMinute(restockJob(noop))).toBeGreaterThanOrEqual(WINDOW_END_MIN);
  });

  // ROZHODNUTÉ 20. 11. 2026 (možnosť 1): shop-sitemap spúšťal blok sám — blok
  // sa posunul presne s jeho slotom (04:05 → 08:35). Job je odstránený.
  it("shop-sitemap job už neexistuje", () => {
    expect(Object.keys(jobs)).not.toContain("shopSitemapJob");
  });

  it("supplier-stock štartuje najneskôr 2,5 h pred oknom, aby reťazený restock dobehol pred 04:00", () => {
    expect(startMinute(supplierStockJob(noop))).toBeLessThanOrEqual(WINDOW_START_MIN - 150);
  });
});
