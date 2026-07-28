import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { login, logout } from "../modules/auth/service.js";
import { appVersion } from "../version.js";
import { SESSION_COOKIE, requireUser, type AppBindings } from "./middleware.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export function createApp(db: Database, options: { cookieSecure: boolean }): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    const start = performance.now();
    c.header("x-request-id", requestId);
    await next();
    log.debug({
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      elapsedMs: Math.round(performance.now() - start),
    });
  });

  app.get("/api/version", (c) => c.json(appVersion()));

  app.post("/api/login", zValidator("json", loginSchema), async (c) => {
    const body = c.req.valid("json");
    const session = await login(db, { ...body, now: new Date() });
    if (session === null) {
      log.warn({ email: body.email, reason: "zle_heslo_alebo_email" }, "neúspešné prihlásenie");
      return c.json({ error: "Nesprávny e-mail alebo heslo" }, 401);
    }
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: options.cookieSecure,
      sameSite: "Lax",
      path: "/",
      expires: session.expiresAt,
    });
    return c.json({ ok: true });
  });

  app.post("/api/logout", async (c) => {
    await logout(db, getCookie(c, SESSION_COOKIE) ?? "", new Date());
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/me", requireUser(db), (c) => c.json(c.get("user")));

  return app;
}
