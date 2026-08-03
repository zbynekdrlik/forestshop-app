import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { login, logout, resolveSession } from "../src/modules/auth/service.js";
import { hashPassword, verifyPassword } from "../src/modules/auth/passwords.js";
import {
  createLegacyScryptHash,
  isLegacyScryptHash,
} from "../src/modules/auth/legacy-scrypt.js";
import { SESSION_TTL_MS } from "../src/modules/auth/sessions.js";
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

it("relácia platí tesne pred expiráciou a neplatí presne v okamihu expirácie", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await seed(ctx.db);

  const session = await login(ctx.db, {
    email: "manazer@forestshop.sk",
    password: HESLO,
    now: NOW,
  });
  const expiresAt = session?.expiresAt ?? new Date(NOW.getTime() + SESSION_TTL_MS);
  const tesnePred = new Date(expiresAt.getTime() - 1);
  await expect(resolveSession(ctx.db, session?.token ?? "", tesnePred)).resolves.not.toBeNull();
  await expect(resolveSession(ctx.db, session?.token ?? "", expiresAt)).resolves.toBeNull();
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
  await logout(ctx.db, session?.token ?? "", NOW);
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

// --- prenesené účty zo starej appky (#189) ---------------------------------

const STARE_HESLO = "stare-heslo-zo-starej-appky"; // testovacie údaje, nie tajomstvo

async function seedStary(
  db: Awaited<ReturnType<typeof withCleanDb>>["db"],
): Promise<void> {
  await db.insert(users).values({
    email: "prenesena@forestshop.sk",
    passwordHash: await createLegacyScryptHash(STARE_HESLO),
    displayName: "Prenesená",
    role: "manazer",
  });
}

async function ulozenyOdtlacok(
  db: Awaited<ReturnType<typeof withCleanDb>>["db"],
): Promise<string> {
  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, "prenesena@forestshop.sk"))
    .limit(1);
  return row?.passwordHash ?? "";
}

it("prihlási prenesený účet jeho pôvodným heslom a odtlačok prepíše na argon2id", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await seedStary(ctx.db);
  expect(isLegacyScryptHash(await ulozenyOdtlacok(ctx.db))).toBe(true);

  const session = await login(ctx.db, {
    email: "prenesena@forestshop.sk",
    password: STARE_HESLO,
    now: NOW,
  });
  expect(session).not.toBeNull();

  const po = await ulozenyOdtlacok(ctx.db);
  expect(isLegacyScryptHash(po)).toBe(false);
  expect(po.startsWith("$argon2id$")).toBe(true);
  await expect(verifyPassword(po, STARE_HESLO)).resolves.toBe(true);
});

it("prenesený účet sa po prepise prihlási rovnakým heslom aj druhýkrát", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await seedStary(ctx.db);

  await login(ctx.db, { email: "prenesena@forestshop.sk", password: STARE_HESLO, now: NOW });
  const druhe = await login(ctx.db, {
    email: "prenesena@forestshop.sk",
    password: STARE_HESLO,
    now: NOW,
  });
  expect(druhe).not.toBeNull();
  expect(await resolveSession(ctx.db, druhe?.token ?? "", NOW)).not.toBeNull();
});

it("nesprávne heslo prenesený odtlačok nezmení", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await seedStary(ctx.db);
  const pred = await ulozenyOdtlacok(ctx.db);

  const session = await login(ctx.db, {
    email: "prenesena@forestshop.sk",
    password: ZLE_HESLO,
    now: NOW,
  });
  expect(session).toBeNull();
  expect(await ulozenyOdtlacok(ctx.db)).toBe(pred);
});
