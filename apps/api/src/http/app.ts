import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { changePassword } from "../modules/auth/change-password.js";
import { MIN_NEW_PASSWORD_LENGTH } from "../modules/auth/passwords.js";
import { login, logout } from "../modules/auth/service.js";
import { appVersion } from "../version.js";
import { registerCatalogRoutes, type RunIngest } from "./catalog-routes.js";
import { checkLoginRateLimit, clientIp } from "./login-rate-limit.js";
import { SESSION_COOKIE, requireUser, type AppBindings } from "./middleware.js";
import { registerOrdersRoutes, type RunOrdersIngest } from "./orders-routes.js";
import { requireSameOrigin } from "./origin-check.js";
import { registerSchedulerRoutes } from "./scheduler-routes.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(MIN_NEW_PASSWORD_LENGTH),
});

export function createApp(
  db: Database,
  options: {
    readonly cookieSecure: boolean;
    readonly runIngest?: RunIngest;
    readonly runOrdersIngest?: RunOrdersIngest;
  },
): Hono<AppBindings> {
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
    const now = new Date();
    if (!checkLoginRateLimit(clientIp(c), body.email, now)) {
      return c.json({ error: "Priveľa pokusov o prihlásenie. Skúste to znova o pár minút." }, 429);
    }
    const session = await login(db, { ...body, now });
    if (session === null) {
      // Bez e-mailu — ten už má vlastný riadok v audit_events (login.failed cez
      // record() v modules/auth/service.ts), duplikovať ho aj sem by len rozšírilo
      // plochu, na ktorej sa e-mail používateľa niekde v logoch objaví.
      log.warn({ reason: "zle_heslo_alebo_email" }, "neúspešné prihlásenie");
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

  app.post("/api/logout", requireSameOrigin(), async (c) => {
    await logout(db, getCookie(c, SESSION_COOKIE) ?? "", new Date());
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/me", requireUser(db), (c) => c.json(c.get("user")));

  app.post(
    "/api/me/password",
    // Rovnaká CSRF disciplína ako `/api/logout` a import katalógu
    // (`origin-check.ts`) — ide o stavovo-meniacu požiadavku nad
    // autentifikovaným cookie session-om.
    requireSameOrigin(),
    requireUser(db),
    zValidator("json", changePasswordSchema),
    async (c) => {
      const body = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      const result = await changePassword(db, {
        userId: user.userId,
        oldPassword: body.oldPassword,
        newPassword: body.newPassword,
        currentSessionToken: getCookie(c, SESSION_COOKIE) ?? "",
        now,
      });
      // Zámerne 200 aj pre "zlé staré heslo" — je to bežný, očakávaný
      // DOMÉNOVÝ výsledok (rovnaká rodina rozhodnutí ako `/api/catalog/ingest`
      // vraciace 200 `{status: "busy"}`/"rejected" pre iný nechybový výsledok
      // importu), nie chyba na úrovni HTTP. Chromium loguje "Failed to load
      // resource" do konzoly pre KAŽDÝ fetch s 4xx/5xx bez ohľadu na to, či ho
      // JS odchytí — pri 4xx by to pri zlom starom hesle (bežná, očakávaná
      // používateľská chyba, nie výnimočný stav) porušilo pravidlo čistej
      // konzoly (`testing.md` zakazuje rozširovať jedinú dnes povolenú
      // výnimku o ďalšie cesty/kódy). 401 zostáva vyhradené pre skutočnú
      // stratu relácie (`requireUser` vyššie v reťazci), 403 pre CSRF.
      if (result === "wrong_old_password") {
        return c.json({ ok: false, error: "Nesprávne staré heslo" });
      }
      return c.json({ ok: true });
    },
  );

  registerCatalogRoutes(app, db, options.runIngest);
  registerOrdersRoutes(app, db, options.runOrdersIngest);
  registerSchedulerRoutes(app, db);

  // Musí byť registrovaný AŽ PO všetkých skutočných /api/* trasách vyššie — Hono
  // vyberá presnejšiu zhodu, takže tie majú prednosť a sem sa dostane len to, čo
  // nesedí na žiadnu z nich. Bez tohto by neznáma /api/* cesta spadla až na SPA
  // fallback (serveStatic index.html) pridaný v index.ts a tichým 200 by
  // schovala preklep v ceste namiesto viditeľnej chyby.
  app.all("/api/*", (c) => c.json({ error: "Nenájdená API cesta" }, 404));

  return app;
}
