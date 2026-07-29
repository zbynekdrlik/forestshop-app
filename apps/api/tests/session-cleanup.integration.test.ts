import { afterEach, expect, it } from "vitest";
import { sessions, users } from "../src/db/schema.js";
import { cleanupExpiredSessions } from "../src/modules/auth/sessions.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { withCleanDb } from "./helpers/db.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const NOW = new Date("2026-07-29T10:00:00Z");
const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

it("zmaže LEN relácie, ktorých expires_at je v minulosti — platnú reláciu nechá netknutú", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;

  const [user] = await ctx.db
    .insert(users)
    .values({
      email: "manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");

  await ctx.db.insert(sessions).values([
    {
      tokenHash: "expirovana",
      userId: user.id,
      expiresAt: new Date(NOW.getTime() - 1000),
    },
    {
      tokenHash: "platna",
      userId: user.id,
      expiresAt: new Date(NOW.getTime() + 1000),
    },
  ]);

  const result = await cleanupExpiredSessions(ctx.db, NOW);
  expect(result).toEqual({ deletedCount: 1 });

  const zostavajuce = await ctx.db.select({ tokenHash: sessions.tokenHash }).from(sessions);
  expect(zostavajuce).toEqual([{ tokenHash: "platna" }]);
});

it("relácia expirujúca PRESNE v danom okamihu sa už považuje za expirovanú (rovnaká hranica ako resolveSession)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;

  const [user] = await ctx.db
    .insert(users)
    .values({
      email: "manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");

  await ctx.db.insert(sessions).values({ tokenHash: "presne-teraz", userId: user.id, expiresAt: NOW });

  const result = await cleanupExpiredSessions(ctx.db, NOW);
  expect(result).toEqual({ deletedCount: 1 });
});

it("keď nie je čo mazať, vráti deletedCount 0 a nič nezmení", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;

  const [user] = await ctx.db
    .insert(users)
    .values({
      email: "manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");

  await ctx.db.insert(sessions).values({ tokenHash: "platna", userId: user.id, expiresAt: new Date(NOW.getTime() + 1000) });

  const result = await cleanupExpiredSessions(ctx.db, NOW);
  expect(result).toEqual({ deletedCount: 0 });
  expect(await ctx.db.select().from(sessions)).toHaveLength(1);
});
