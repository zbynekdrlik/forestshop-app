import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { Database } from "../db/client.js";
import { resolveSession, type SessionUser, type UserRole } from "../modules/auth/service.js";

export const SESSION_COOKIE = "fs_session";

export interface AppBindings {
  Variables: { user: SessionUser };
}

export function requireUser(db: Database) {
  return async (c: Context<AppBindings>, next: Next): Promise<Response | undefined> => {
    const token = getCookie(c, SESSION_COOKIE) ?? "";
    const user = await resolveSession(db, token, new Date());
    if (user === null) {
      return c.json({ error: "Neprihlásený" }, 401);
    }
    c.set("user", user);
    await next();
    return undefined;
  };
}

export function requireRole(...roles: readonly UserRole[]) {
  return async (c: Context<AppBindings>, next: Next): Promise<Response | undefined> => {
    // Beží VŽDY až za requireUser — bez neho by `user` nebol nastavený.
    if (!roles.includes(c.get("user").role)) {
      return c.json({ error: "Nemáte oprávnenie na túto akciu" }, 403);
    }
    await next();
    return undefined;
  };
}
