import { and, eq, gt } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { sessions, users } from "../../db/schema.js";
import { record } from "../audit/service.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { SESSION_TTL_MS, hashToken, newSessionToken } from "./sessions.js";

// Dummy hash used to verify a password against when the e-mail is unknown, so that
// an unknown-e-mail login takes the SAME argon2-verify time as a known-e-mail login
// with a wrong password. Without this, the `||` short-circuit below would skip
// argon2 entirely for unknown e-mails, and the response TIME (not its content)
// would reveal whether the account exists — an e-mail enumeration side channel.
// DO NOT "optimize" this away by short-circuiting on `user === undefined` again.
const DUMMY_PASSWORD_HASH = await hashPassword("dummy-password-for-constant-time-login");

export type UserRole = "admin" | "manazer" | "sef" | "citanie";

export interface SessionUser {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: UserRole;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly now: Date;
}

export async function login(
  db: Database,
  input: LoginInput,
): Promise<{ token: string; expiresAt: Date } | null> {
  const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
  // Always verify — even when the e-mail is unknown — so both paths perform the same
  // argon2 work and take the same time. See DUMMY_PASSWORD_HASH above for why.
  const passwordOk = await verifyPassword(user?.passwordHash ?? DUMMY_PASSWORD_HASH, input.password);
  if (user === undefined || !passwordOk) {
    await record(db, {
      actorUserId: user?.id,
      action: "login.failed",
      entity: "user",
      entityId: user?.id,
      data: { email: input.email },
      at: input.now,
    });
    return null;
  }
  const { token, tokenHash } = newSessionToken();
  const expiresAt = new Date(input.now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash, userId: user.id, expiresAt });
  await record(db, {
    actorUserId: user.id,
    action: "login.ok",
    entity: "user",
    entityId: user.id,
    at: input.now,
  });
  return { token, expiresAt };
}

export async function resolveSession(
  db: Database,
  token: string,
  now: Date,
): Promise<SessionUser | null> {
  if (token === "") return null;
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

export async function logout(db: Database, token: string, now: Date): Promise<void> {
  const tokenHash = hashToken(token);
  const [session] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  if (session !== undefined) {
    await record(db, {
      actorUserId: session.userId,
      action: "logout.ok",
      entity: "user",
      entityId: session.userId,
      at: now,
    });
  }
}
