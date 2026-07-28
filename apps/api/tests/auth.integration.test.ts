import { afterEach, expect, it } from "vitest";
import { login, logout, resolveSession } from "../src/modules/auth/service.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { auditEvents, users } from "../src/db/schema.js";
import { withCleanDb } from "./helpers/db.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

const NOW = new Date("2026-07-29T10:00:00Z");
const HESLO = "test-heslo-abc";     // testovacie údaje, nie tajomstvo — nikde inde sa nepoužívajú
const ZLE_HESLO = "nespravne";

async function seed(db: Awaited<ReturnType<typeof withCleanDb>>["db"]): Promise<void> {
  await db.insert(users).values({
    email: "manazer@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Manažér",
    role: "manazer",
  });
}

it("prihlási správnym heslom a relácia platí", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await seed(ctx.db);

  const session = await login(ctx.db, {
    email: "manazer@forestshop.sk",
    password: HESLO,
    now: NOW,
  });
  expect(session).not.toBeNull();

  const resolved = await resolveSession(ctx.db, session?.token ?? "", NOW);
  expect(resolved?.role).toBe("manazer");
});

it("odmietne nesprávne heslo a nevytvorí reláciu", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await seed(ctx.db);

  const session = await login(ctx.db, {
    email: "manazer@forestshop.sk",
    password: ZLE_HESLO,
    now: NOW,
  });
  expect(session).toBeNull();
});

it("expirovaná relácia neplatí", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await seed(ctx.db);

  const session = await login(ctx.db, {
    email: "manazer@forestshop.sk",
    password: HESLO,
    now: NOW,
  });
  const neskor = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
  await expect(resolveSession(ctx.db, session?.token ?? "", neskor)).resolves.toBeNull();
});

it("odhlásenie zruší reláciu", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await seed(ctx.db);

  const session = await login(ctx.db, {
    email: "manazer@forestshop.sk",
    password: HESLO,
    now: NOW,
  });
  await logout(ctx.db, session?.token ?? "");
  await expect(resolveSession(ctx.db, session?.token ?? "", NOW)).resolves.toBeNull();
});

it("prihlásenie aj neúspešný pokus nechajú záznam v audite", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await seed(ctx.db);

  await login(ctx.db, { email: "manazer@forestshop.sk", password: HESLO, now: NOW });
  await login(ctx.db, { email: "manazer@forestshop.sk", password: ZLE_HESLO, now: NOW });

  const events = await ctx.db.select().from(auditEvents);
  expect(events.map((e) => e.action).sort()).toEqual(["login.failed", "login.ok"]);
});
