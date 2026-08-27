import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { auditEvents, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { returnUpozornenieDedupKey } from "../src/modules/orders/return-status.js";
import { resolveUpozornenie, upsertUpozornenie } from "../src/modules/upozornenia/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 290: HTTP vrstva pre "Eshop → Výmena tovaru / Vrátený tovar /
// Reklamácie". Vlastný súbor (rovnaký dôvod ako `upozornenia-http
// .integration.test.ts`, eslint `max-lines: 400`).
const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole) {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [pouzivatel] = await ctx.db
    .insert(users)
    .values({ email: "pouzivatel@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Test", role })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");
  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pouzivatel@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db, userId: pouzivatel.id };
}

let poradie = 0;
async function insertOrder(
  db: Awaited<ReturnType<typeof boot>>["db"],
  statusName: string,
  options: { readonly comment?: string | null } = {},
): Promise<{ id: string; externalOrderId: string }> {
  poradie += 1;
  const externalOrderId = `9${String(poradie).padStart(5, "0")}`;
  const [order] = await db
    .insert(orders)
    .values({
      externalOrderId,
      customerName: "Zákazník testovaný",
      statusName,
      comment: options.comment ?? null,
      placedAt: new Date("2026-07-20T00:00:00Z"),
      totalPriceWithVat: "42.00",
    })
    .returning({ id: orders.id, externalOrderId: orders.externalOrderId });
  if (order === undefined) throw new Error("insert objednávky zlyhal");
  return order;
}

describe("GET /api/order-flags/exchange", () => {
  it("vráti len AKTÍVne výmeny (stav 'Výmena tovaru'), 'Vybavená výmena' sa už NEzobrazuje (issue 514)", async () => {
    const { app, cookie, db } = await boot("citanie");
    const vymena = await insertOrder(db, "Výmena tovaru", { comment: "poznámka k výmene" });
    await insertOrder(db, "Vybavená výmena"); // vybavená výmena — issue 514 ju z výpisu odstránilo
    await insertOrder(db, "Vybavená"); // iný stav — nesmie sa objaviť
    await insertOrder(db, "Vratený tovar"); // iný stav — nesmie sa objaviť
    // Lingering otvorená vratenie karta (zriedkavý prípad Vratený tovar → Výmena
    // tovaru) → unresolved: true; zdieľaný `OrderFlagTable` štítok ostáva funkčný.
    await upsertUpozornenie(db, {
      type: "vratenie",
      source: "appka",
      title: "test",
      dedupKey: returnUpozornenieDedupKey(vymena.externalOrderId),
      now: new Date("2026-07-21T00:00:00Z"),
    });

    const res = await app.request("/api/order-flags/exchange", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: readonly Record<string, unknown>[] };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]?.["externalOrderId"]).toBe(vymena.externalOrderId);
    expect(body.orders[0]?.["statusName"]).toBe("Výmena tovaru");
    expect(body.orders[0]?.["comment"]).toBe("poznámka k výmene");
    expect(body.orders[0]?.["unresolved"]).toBe(true);
  });

  it("aktívna výmena bez otvorenej vratenie karty je unresolved: false", async () => {
    const { app, cookie, db } = await boot("citanie");
    await insertOrder(db, "Výmena tovaru");

    const res = await app.request("/api/order-flags/exchange", { headers: { cookie } });
    const body = (await res.json()) as { orders: readonly Record<string, unknown>[] };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]?.["unresolved"]).toBe(false);
  });

  it("VYRIEŠENÁ vratenie karta neznamená unresolved — len otvorená karta počíta", async () => {
    const { app, cookie, db, userId } = await boot("citanie");
    const vymena = await insertOrder(db, "Výmena tovaru");
    const card = await upsertUpozornenie(db, {
      type: "vratenie",
      source: "appka",
      title: "test",
      dedupKey: returnUpozornenieDedupKey(vymena.externalOrderId),
      now: new Date("2026-07-21T00:00:00Z"),
    });
    await resolveUpozornenie(db, { id: card.id, resolvedByUserId: userId, now: new Date("2026-07-22T00:00:00Z") });

    const res = await app.request("/api/order-flags/exchange", { headers: { cookie } });
    const body = (await res.json()) as { orders: readonly Record<string, unknown>[] };
    expect(body.orders[0]?.["unresolved"]).toBe(false);
  });

  it("bez prihlásenia vráti 401", async () => {
    const { app } = await boot("manazer");
    const res = await app.request("/api/order-flags/exchange");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/order-flags/returned", () => {
  it("vráti LEN aktívne 'Vratený tovar', 'Vybavený Dobropis' sa už NEzobrazuje (issue 516)", async () => {
    const { app, cookie, db } = await boot("citanie");
    const vrateny = await insertOrder(db, "Vratený tovar");
    await insertOrder(db, "Vybavený Dobropis"); // vybavený dobropis — issue 516 ho z výpisu odstránilo
    await insertOrder(db, "Vybavená výmena"); // iná stránka — nesmie sa objaviť

    const res = await app.request("/api/order-flags/returned", { headers: { cookie } });
    const body = (await res.json()) as { orders: readonly Record<string, unknown>[] };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]?.["externalOrderId"]).toBe(vrateny.externalOrderId);
    expect(body.orders[0]?.["statusName"]).toBe("Vratený tovar");
  });
});

describe("GET /api/order-flags/claims", () => {
  it("prázdny zoznam, kým nikto nič neoznačil", async () => {
    const { app, cookie, db } = await boot("citanie");
    await insertOrder(db, "Vybavená");
    const res = await app.request("/api/order-flags/claims", { headers: { cookie } });
    const body = (await res.json()) as { orders: readonly unknown[] };
    expect(body.orders).toEqual([]);
  });

  it("po označení sa objednávka objaví so svojou poznámkou, unresolved vždy true", async () => {
    const { app, cookie, db } = await boot("manazer");
    const objednavka = await insertOrder(db, "Vybavená");

    const mark = await app.request("/api/order-flags/claims", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderCode: objednavka.externalOrderId, note: "chybný zips" }),
    });
    expect(mark.status).toBe(200);
    expect(((await mark.json()) as { ok: boolean }).ok).toBe(true);

    const res = await app.request("/api/order-flags/claims", { headers: { cookie } });
    const body = (await res.json()) as { orders: readonly Record<string, unknown>[] };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]?.["claimNote"]).toBe("chybný zips");
    expect(body.orders[0]?.["unresolved"]).toBe(true);
  });
});

describe("POST /api/order-flags/claims", () => {
  it("čítanie ('citanie') nemôže označiť reklamáciu — 403", async () => {
    const { app, cookie, db } = await boot("citanie");
    const objednavka = await insertOrder(db, "Vybavená");
    const res = await app.request("/api/order-flags/claims", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderCode: objednavka.externalOrderId }),
    });
    expect(res.status).toBe(403);
  });

  it("neexistujúce číslo objednávky vráti ok:false s hláškou, nič neuloží", async () => {
    const { app, cookie } = await boot("manazer");
    const res = await app.request("/api/order-flags/claims", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderCode: "neexistuje-123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it("označenie zapíše audit záznam s kým a poznámkou", async () => {
    const { app, cookie, db, userId } = await boot("manazer");
    const objednavka = await insertOrder(db, "Vybavená");
    await app.request("/api/order-flags/claims", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderCode: objednavka.externalOrderId, note: "poznámka" }),
    });

    const [event] = await db.select().from(auditEvents).where(eq(auditEvents.action, "order.claim.marked"));
    expect(event?.actorUserId).toBe(userId);
    expect(event?.entityId).toBe(objednavka.id);
  });
});

describe("POST /api/order-flags/claims/:id/clear", () => {
  it("zruší označenie — objednávka zmizne zo zoznamu reklamácií", async () => {
    const { app, cookie, db } = await boot("manazer");
    const objednavka = await insertOrder(db, "Vybavená");
    await app.request("/api/order-flags/claims", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderCode: objednavka.externalOrderId }),
    });

    const clear = await app.request(`/api/order-flags/claims/${objednavka.id}/clear`, {
      method: "POST",
      headers: { cookie },
    });
    expect(clear.status).toBe(200);
    expect(((await clear.json()) as { ok: boolean }).ok).toBe(true);

    const res = await app.request("/api/order-flags/claims", { headers: { cookie } });
    const body = (await res.json()) as { orders: readonly unknown[] };
    expect(body.orders).toEqual([]);
  });

  it("zrušenie NEOZNAČENEJ objednávky (nič neoznačené) je no-op ok:true — nikdy nespadne", async () => {
    const { app, cookie, db } = await boot("manazer");
    const objednavka = await insertOrder(db, "Vybavená");
    const res = await app.request(`/api/order-flags/claims/${objednavka.id}/clear`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("neexistujúce id objednávky vráti ok:false", async () => {
    const { app, cookie } = await boot("manazer");
    const res = await app.request("/api/order-flags/claims/00000000-0000-0000-0000-000000000000/clear", {
      method: "POST",
      headers: { cookie },
    });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

describe("GET /api/order-flags/counts", () => {
  it("exchange = počet VŠETKÝCH aktívnych výmen, returned = počet VŠETKÝCH aktívnych vrátení (nie unresolved-filtrovaný), claims = označené (issue 514 + 516)", async () => {
    const { app, cookie, db } = await boot("manazer");
    // Dve aktívne výmeny: jedna s otvorenou vratenie kartou, jedna bez. Badge
    // (issue 514) počíta OBE — dôkaz, že to NIE JE unresolved-filtrovaný count.
    const vymenaSKartou = await insertOrder(db, "Výmena tovaru");
    await insertOrder(db, "Výmena tovaru");
    await upsertUpozornenie(db, {
      type: "vratenie",
      source: "appka",
      title: "t",
      dedupKey: returnUpozornenieDedupKey(vymenaSKartou.externalOrderId),
      now: new Date("2026-07-21T00:00:00Z"),
    });
    await insertOrder(db, "Vybavená výmena"); // vybavená výmena sa NEpočíta (issue 514)
    // issue 516: aktívne "Vratený tovar" BEZ karty sa TERAZ počíta (returned je
    // počet všetkých aktívnych vrátení, nie unresolved-filtrovaný) → 1.
    await insertOrder(db, "Vratený tovar");
    await insertOrder(db, "Vybavený Dobropis"); // vybavený dobropis sa NEpočíta (issue 516)
    const reklamacia = await insertOrder(db, "Vybavená");
    await app.request("/api/order-flags/claims", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderCode: reklamacia.externalOrderId }),
    });

    const res = await app.request("/api/order-flags/counts", { headers: { cookie } });
    const body = (await res.json()) as { exchange: number; returned: number; claims: number };
    expect(body).toEqual({ exchange: 2, returned: 1, claims: 1 });
  });
});

// issue 516 [red]: reprodukuje rozchod „3 vs 2" pri sekcii Vrátený tovar.
// Pred fixom má sekcia DVE rôzne dátové cesty: výpis (`isReturnedOrderStatus`
// = „Vratený tovar" ALEBO „Vybavený Dobropis", stavovo) a odznak
// (unresolved-filtrovaný — len objednávky s otvorenou vratenie kartou). Tri
// aktívne „Vratený tovar" (2 s kartou) + 1 „Vybavený Dobropis" tak pred fixom
// dajú výpis = 4 a odznak = 2. Po fixe (zrkadlo #514) zdieľajú JEDEN predikát
// → výpis = odznak = 3, dobropis sa nezobrazuje ani nepočíta.
describe("Vrátený tovar — odznak == výpis, len aktívne 'Vratený tovar' (issue 516, rozchod 3 vs 2)", () => {
  it("výpis obsahuje LEN 'Vratený tovar' (žiadny 'Vybavený Dobropis') a odznak sa rovná jeho dĺžke", async () => {
    const { app, cookie, db } = await boot("manazer");
    // Tri aktívne „Vratený tovar" — LEN dve majú otvorenú vratenie kartu (tretia bez).
    const sKartou1 = await insertOrder(db, "Vratený tovar");
    const sKartou2 = await insertOrder(db, "Vratený tovar");
    await insertOrder(db, "Vratený tovar"); // bez otvorenej karty
    for (const o of [sKartou1, sKartou2]) {
      await upsertUpozornenie(db, {
        type: "vratenie",
        source: "appka",
        title: "t",
        dedupKey: returnUpozornenieDedupKey(o.externalOrderId),
        now: new Date("2026-07-21T00:00:00Z"),
      });
    }
    await insertOrder(db, "Vybavený Dobropis"); // vybavený dobropis — do výpisu ani počtu už nepatrí (issue 516)

    const listRes = await app.request("/api/order-flags/returned", { headers: { cookie } });
    const list = ((await listRes.json()) as { orders: readonly Record<string, unknown>[] }).orders;
    const countsRes = await app.request("/api/order-flags/counts", { headers: { cookie } });
    const counts = (await countsRes.json()) as { returned: number };

    expect(list).toHaveLength(3);
    expect(list.every((o) => o["statusName"] === "Vratený tovar")).toBe(true);
    // Jeden zdieľaný predikát: odznak == dĺžka výpisu == počet aktívnych vrátení.
    expect(counts.returned).toBe(list.length);
    expect(counts.returned).toBe(3);
  });
});
