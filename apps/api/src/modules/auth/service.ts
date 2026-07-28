import { and, eq, gt } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { sessions, users } from "../../db/schema.js";
import { record } from "../audit/service.js";
import { verifyPassword } from "./passwords.js";
import { SESSION_TTL_MS, hashToken, newSessionToken } from "./sessions.js";

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
  if (user === undefined || !(await verifyPassword(user.passwordHash, input.password))) {
    await record(db, {
      action: "login.failed",
      entity: "user",
      entityId: user?.id,
      data: { email: input.email },
    });
    return null;
  }
  const { token, tokenHash } = newSessionToken();
  const expiresAt = new Date(input.now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash, userId: user.id, expiresAt });
  await record(db, { actorUserId: user.id, action: "login.ok", entity: "user", entityId: user.id });
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

export async function logout(db: Database, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}
