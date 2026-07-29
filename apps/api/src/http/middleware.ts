import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { Database } from "../db/client.js";
import { resolveSession, type SessionUser } from "../modules/auth/service.js";

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
