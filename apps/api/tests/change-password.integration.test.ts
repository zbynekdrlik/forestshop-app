import { afterEach, expect, it } from "vitest";
import { changePassword } from "../src/modules/auth/change-password.js";
import { login, resolveSession } from "../src/modules/auth/service.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { auditEvents, users } from "../src/db/schema.js";
import { withCleanDb } from "./helpers/db.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const NOW = new Date("2026-07-29T10:00:00Z");
const NESKOR = new Date("2026-07-29T10:05:00Z");
const STARE_HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo
const ZLE_STARE_HESLO = "nespravne-stare-heslo";
const NOVE_HESLO = "nove-tajne-heslo-123";

async function seed(db: Awaited<ReturnType<typeof withCleanDb>>["db"]): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: "manazer@forestshop.sk",
      passwordHash: await hashPassword(STARE_HESLO),
      displayName: "Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");
  return user.id;
}

it("úspešná zmena hesla: staré heslo prestane fungovať, nové zaberie, zápis v audite", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const userId = await seed(ctx.db);
  const session = await login(ctx.db, { email: "manazer@forestshop.sk", password: STARE_HESLO, now: NOW });
  if (session === null) throw new Error("prihlásenie zlyhalo");

  const result = await changePassword(ctx.db, {
    userId,
    oldPassword: STARE_HESLO,
    newPassword: NOVE_HESLO,
    currentSessionToken: session.token,
    now: NESKOR,
  });
  expect(result).toBe("ok");

  await expect(
    login(ctx.db, { email: "manazer@forestshop.sk", password: STARE_HESLO, now: NESKOR }),
  ).resolves.toBeNull();
  await expect(
    login(ctx.db, { email: "manazer@forestshop.sk", password: NOVE_HESLO, now: NESKOR }),
  ).resolves.not.toBeNull();

  const events = await ctx.db.select().from(auditEvents);
  expect(events.map((e) => e.action)).toContain("password.change.ok");
});

it("zlé staré heslo: zmena sa odmietne, heslo aj relácie ostanú netknuté, zápis v audite", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const userId = await seed(ctx.db);
  const session = await login(ctx.db, { email: "manazer@forestshop.sk", password: STARE_HESLO, now: NOW });
  if (session === null) throw new Error("prihlásenie zlyhalo");

  const result = await changePassword(ctx.db, {
    userId,
    oldPassword: ZLE_STARE_HESLO,
    newPassword: NOVE_HESLO,
    currentSessionToken: session.token,
    now: NESKOR,
  });
  expect(result).toBe("wrong_old_password");

  // pôvodné heslo stále platí
  await expect(
    login(ctx.db, { email: "manazer@forestshop.sk", password: STARE_HESLO, now: NESKOR }),
  ).resolves.not.toBeNull();
  // relácia zostala platná (nič sa nezrušilo)
  await expect(resolveSession(ctx.db, session.token, NESKOR)).resolves.not.toBeNull();

  const events = await ctx.db.select().from(auditEvents);
  expect(events.map((e) => e.action)).toContain("password.change.failed");
});

it("po zmene hesla PRESTANE platiť INÁ (staršia) relácia toho istého používateľa, aktuálna relácia ostáva platná", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const userId = await seed(ctx.db);

  const stara = await login(ctx.db, { email: "manazer@forestshop.sk", password: STARE_HESLO, now: NOW });
  const aktualna = await login(ctx.db, {
    email: "manazer@forestshop.sk",
    password: STARE_HESLO,
    now: NOW,
  });
  if (stara === null || aktualna === null) throw new Error("prihlásenie zlyhalo");

  const result = await changePassword(ctx.db, {
    userId,
    oldPassword: STARE_HESLO,
    newPassword: NOVE_HESLO,
    currentSessionToken: aktualna.token,
    now: NESKOR,
  });
  expect(result).toBe("ok");

  await expect(resolveSession(ctx.db, stara.token, NESKOR)).resolves.toBeNull();
  await expect(resolveSession(ctx.db, aktualna.token, NESKOR)).resolves.not.toBeNull();
});
