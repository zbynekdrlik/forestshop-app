import { afterEach, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { withCleanDb } from "./helpers/db.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

it("uloží používateľa a prečíta ho späť", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "test@forestshop.sk",
    passwordHash: "x",
    displayName: "Test",
    role: "admin",
  });
  const rows = await ctx.db.select().from(users);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.role).toBe("admin");
});

it("odmietne druhého používateľa s rovnakým e-mailom", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const row = { email: "a@b.sk", passwordHash: "x", displayName: "A", role: "admin" as const };
  await ctx.db.insert(users).values(row);
  await expect(ctx.db.insert(users).values(row)).rejects.toThrow();
});
