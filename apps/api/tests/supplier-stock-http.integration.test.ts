import { afterEach, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { SUPPLIER_STOCK_JOB_NAME } from "../src/modules/supplier-stock/constants.js";
import type { PageFetchResult } from "../src/modules/supplier-stock/page-fetcher.js";
import { runSupplierStock } from "../src/modules/supplier-stock/run.js";
import { withCleanDb } from "./helpers/db.js";
import { waitForJobRunSettled } from "./helpers/job-run.js";
import { insertTestVariant } from "./helpers/orders.js";

// issue 227: HTTP vrstva pre prehľad podľa domény + vylúčenie vlastného
// e-shopu. Falošný `fetchPage` — nikdy skutočná dodávateľská stránka.
const HESLO = "test-heslo-abc";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

const IN_STOCK = `<script type="application/ld+json">
  {"@type":"Product","offers":{"@type":"Offer","availability":"https://schema.org/InStock"}}
</script>`;

async function boot(role: UserRole = "citanie") {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "pouzivatel@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Test",
    role,
  });
  const app = createApp(ctx.db, {
    cookieSecure: false,
    fetchSupplierPage: (): Promise<PageFetchResult> => Promise.resolve({ ok: true, html: IN_STOCK, httpStatus: 200, error: null }),
  });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pouzivatel@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

interface HostOverviewRow {
  readonly host: string;
  readonly total: number;
  readonly readable: number;
  readonly unknown: number;
  readonly failed: number;
  readonly lastConfirmedAt: string | null;
}

it("GET bez prihlásenia vráti 401", async () => {
  const { app } = await boot();
  const res = await app.request("/api/supplier-stock");
  expect(res.status).toBe(401);
});

it("prehľad podľa domény je zoradený podľa počtu klesajúco a NEobsahuje vlastný e-shop, aj keď má odkazy", async () => {
  const { app, db, cookie } = await boot();
  await insertTestVariant(db, "M1", "Dod A", { internalNote: "https://huntingshop.eu/a" });
  await insertTestVariant(db, "M2", "Dod A", { internalNote: "https://huntingshop.eu/b" });
  await insertTestVariant(db, "M3", "Dod B", { internalNote: "https://wetland.sk/c" });
  await insertTestVariant(db, "M4", "Dod C", { internalNote: "https://www.forestshop.sk/nas-produkt/" });

  await runSupplierStock({
    db,
    now: new Date("2026-08-05T00:00:00.000Z"),
    sleep: () => Promise.resolve(),
    fetchPage: (): Promise<PageFetchResult> => Promise.resolve({ ok: true, html: IN_STOCK, httpStatus: 200, error: null }),
  });

  const res = await app.request("/api/supplier-stock", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { hostOverview: HostOverviewRow[]; ownShopLinksCount: number };

  expect(body.hostOverview.map((r) => r.host)).toEqual(["huntingshop.eu", "wetland.sk"]);
  expect(body.hostOverview[0]).toMatchObject({ host: "huntingshop.eu", total: 2, readable: 2, unknown: 0, failed: 0 });
  expect(body.ownShopLinksCount).toBe(1);
});

// issue 413 (review finding — reviewer's 🟡 #2): closes the missing
// HTTP-level run-now coverage for `supplier-stock` — the one of the six
// automations the ticket itself names as the worst offender (~72-minute
// real runs, `.claude/rules/supplier-stock.md`). The shared `startRunNow`
// core is already covered generically (`run-now.integration.test.ts`); this
// proves the ROUTE itself is wired to the 202/busy contract, not still the
// old synchronous shape.
//
// No variant is inserted for these two tests (unlike the GET test above) —
// `runSupplierStockLocked` (`supplier-stock/run.ts`) only ever calls
// `fetchPage` inside its per-link loop, so an empty `variant`/`internal
// _note` population means `collectSupplierLinks` returns zero links and the
// loop body — hence `fetchPage` — never runs at all; `boot()`'s fake
// `fetchSupplierPage` is a belt-and-suspenders safety net on top of that,
// never a live dependency of this specific short-circuit.
it("POST /api/supplier-stock/run-now vráti 202 {ok:true,started:true} HNEĎ a job_run dobehne checked:0", async () => {
  const { app, cookie, db } = await boot("manazer");

  const res = await app.request("/api/supplier-stock/run-now", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { ok: boolean; started: boolean };
  expect(body).toEqual({ ok: true, started: true });

  const finished = await waitForJobRunSettled(db, SUPPLIER_STOCK_JOB_NAME);
  expect(finished.status).toBe("success");
  const detail = finished.detail as { checked: number; failed: number };
  expect(detail.checked).toBe(0);
  expect(detail.failed).toBe(0);
});

it("druhý POST PRESNE počas prebiehajúceho behu vráti 200 {ok:false,error} 'beh už prebieha'", async () => {
  const { app, cookie, db } = await boot("manazer");

  const first = app.request("/api/supplier-stock/run-now", { method: "POST", headers: { cookie } });
  const second = await app.request("/api/supplier-stock/run-now", { method: "POST", headers: { cookie } });
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as { ok: boolean; error: string };
  expect(secondBody.ok).toBe(false);
  expect(secondBody.error).toContain("Beh už prebieha");

  const firstResponse = await first;
  expect(firstResponse.status).toBe(202);
  await waitForJobRunSettled(db, SUPPLIER_STOCK_JOB_NAME);
});
