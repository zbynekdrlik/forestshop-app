import { afterEach, expect, it } from "vitest";
import { orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { computeBratislavaPeriodBoundaries, getOrdersDashboardOverview } from "../src/modules/orders/overview.js";
import { withCleanDb } from "./helpers/db.js";

const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

// `now` pevne 2026-08-04 12:00 UTC (utorok, leto/CEST) — rovnaké ako
// `overview.test.ts`'s hranicové testy, aby sa dalo overiť presne, ktoré
// objednávky do ktorého bucketu spadnú.
const NOW = new Date("2026-08-04T12:00:00Z");
// Miestna polnoc 2026-08-04 (dnes), 2026-08-03 (pondelok tohto týždňa) a
// 2026-08-01 (začiatok mesiaca) — overené v `overview.test.ts`.
const TODAY_START = new Date("2026-08-03T22:00:00Z");
const WEEK_START = new Date("2026-08-02T22:00:00Z");

async function insertOrder(
  db: Awaited<ReturnType<typeof withCleanDb>>["db"],
  externalOrderId: string,
  placedAt: Date,
  totalPriceWithVat: string | null,
): Promise<void> {
  await db.insert(orders).values({ externalOrderId, customerName: "Zákazník", placedAt, totalPriceWithVat });
}

it("zaradí objednávky do dnes/tento týždeň/tento mesiac podľa placedAt (Europe/Bratislava)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  // "dnes" — 1h po miestnej polnoci dneška.
  await insertOrder(db, "9201", new Date(TODAY_START.getTime() + 60 * 60 * 1000), "100.00");
  // "tento týždeň, ale nie dnes" — deň pred dneškom, ešte v tomto týždni.
  await insertOrder(db, "9202", new Date(WEEK_START.getTime() + 60 * 60 * 1000), "50.00");
  // "tento mesiac, ale nie tento týždeň" — 1. augusta (pred pondelkom týždňa).
  await insertOrder(db, "9203", new Date("2026-08-01T10:00:00Z"), "20.00");
  // Mimo okna — júl (nepočíta sa NIKDE).
  await insertOrder(db, "9204", new Date("2026-07-20T10:00:00Z"), "999.00");
  // Presne na hranici "dnes" (>= je INKLUZÍVNE).
  await insertOrder(db, "9205", TODAY_START, "5.00");

  const overview = await getOrdersDashboardOverview(db, NOW);

  expect(overview.today).toEqual({ orderCount: 2, revenue: "105.00" }); // 9201 + 9205
  expect(overview.week).toEqual({ orderCount: 3, revenue: "155.00" }); // + 9202
  expect(overview.month).toEqual({ orderCount: 4, revenue: "175.00" }); // + 9203
});

it("objednávka bez totalPriceWithVat (null) sa zaráta do počtu, nie do tržby", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  await insertOrder(db, "9210", new Date(TODAY_START.getTime() + 60 * 60 * 1000), null);
  await insertOrder(db, "9211", new Date(TODAY_START.getTime() + 2 * 60 * 60 * 1000), "10.00");

  const overview = await getOrdersDashboardOverview(db, NOW);

  expect(overview.today).toEqual({ orderCount: 2, revenue: "10.00" });
});

it("prázdna DB vráti nuly na všetkých troch obdobiach", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  const overview = await getOrdersDashboardOverview(db, NOW);

  expect(overview).toEqual({
    today: { orderCount: 0, revenue: "0.00" },
    week: { orderCount: 0, revenue: "0.00" },
    month: { orderCount: 0, revenue: "0.00" },
  });
});

// issue 237: "Prehľad e-shopu" počíta VŠETKY objednávky, bez ohľadu na
// `status_name` — na rozdiel od "Na objednanie" (open-status filter,
// `orders-open-statuses.integration.test.ts`). Uzavretá objednávka ("Vybavená")
// sa MUSÍ zarátať rovnako ako otvorená.
it("zaráta objednávku bez ohľadu na status_name (uzavretá sa počíta rovnako ako otvorená)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  await db.insert(orders).values({
    externalOrderId: "9220",
    customerName: "Zákazník",
    statusName: "Vybavená",
    placedAt: new Date(TODAY_START.getTime() + 60 * 60 * 1000),
    totalPriceWithVat: "42.00",
  });

  const overview = await getOrdersDashboardOverview(db, NOW);

  expect(overview.today).toEqual({ orderCount: 1, revenue: "42.00" });
});

async function boot() {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [pouzivatel] = await ctx.db
    .insert(users)
    .values({ email: "citanie@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Čítanie", role: "citanie" })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");

  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "citanie@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

it("GET /api/orders/overview bez prihlásenia vráti 401", async () => {
  const { app } = await boot();
  const res = await app.request("/api/orders/overview");
  expect(res.status).toBe(401);
});

// issue 237: rovnaké oprávnenie ako `/api/orders/open` — čítanie (rola
// `citanie`) smie vidieť prehľad, nie je vyhradené manažérom/adminom.
//
// issue 239 (nájdené pri behu tohto balíka, nesúvisiaci s ním): NA ROZDIEL
// od ostatných testov v tomto súbore (ktoré posielajú PEVNÉ `NOW`/
// `TODAY_START` priamo do `getOrdersDashboardOverview`) táto trasa počíta
// "dnes" zo SKUTOČNÉHO `new Date()` na serveri — pevný literál
// `TODAY_START` (2026-08-03/04) preto po prekročení toho kalendárneho dňa
// prestal byť "dnes" a test spoľahlivo zlyhal (pozorované naživo pri
// prechode 2026-08-04 → 2026-08-05). Fix: rovnaká hranica, ale prepočítaná
// zo SKUTOČNÉHO `new Date()` v momente behu testu (`computeBratislavaPeriodBoundaries`,
// tá istá funkcia, akú používa aj samotná trasa) — test tak zostáva platný
// v KTORÝKOĽVEK deň, nielen v deň napísania.
it("GET /api/orders/overview vráti počty aj tržbu za dnes/týždeň/mesiac (rola 'citanie' smie čítať)", async () => {
  const { app, cookie, db } = await boot();
  const skutocneDnesStart = computeBratislavaPeriodBoundaries(new Date()).today;
  await insertOrder(db, "9230", new Date(skutocneDnesStart.getTime() + 60 * 60 * 1000), "77.50");

  const res = await app.request("/api/orders/overview", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as {
    today: { orderCount: number; revenue: string };
    week: { orderCount: number; revenue: string };
    month: { orderCount: number; revenue: string };
  };
  expect(telo.today).toEqual({ orderCount: 1, revenue: "77.50" });
  expect(telo.week.orderCount).toBeGreaterThanOrEqual(1);
  expect(telo.month.orderCount).toBeGreaterThanOrEqual(1);
});

// `.claude/rules/http-routes.md`: literálna cesta `/api/orders/overview`
// MUSÍ byť zaregistrovaná PRED `GET /api/orders/:id` — inak by "overview"
// spadlo do `:id` parametra a zlyhalo na neplatnom UUID namiesto toho, aby
// sa dostalo k svojmu vlastnému handleru. Dôkaz reachability, nie len
// existencie.
it("/api/orders/overview je dosiahnuteľná (nekolíduje s /api/orders/:id)", async () => {
  const { app, cookie } = await boot();
  const res = await app.request("/api/orders/overview", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as { today: unknown };
  expect(telo).toHaveProperty("today");
});
