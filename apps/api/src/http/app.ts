import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { changePassword } from "../modules/auth/change-password.js";
import { MIN_NEW_PASSWORD_LENGTH } from "../modules/auth/passwords.js";
import { login, logout, resolveSession } from "../modules/auth/service.js";
import type { MailTransport } from "../modules/mail/transport.js";
import { appVersion } from "../version.js";
import { registerCalendarRoutes } from "./calendar-routes.js";
import type { NextEventService } from "../modules/calendar/service.js";
import { registerCatalogRoutes, type RunIngest } from "./catalog-routes.js";
import { registerDailyTasksRoutes } from "./daily-tasks-routes.js";
import { registerDpdRoutes, type DpdRunDeps } from "./dpd-routes.js";
import { registerFloorNotesRoutes } from "./floor-notes-routes.js";
import { checkLoginRateLimit, clientIp } from "./login-rate-limit.js";
import { SESSION_COOKIE, requireUser, type AppBindings } from "./middleware.js";
import { registerOrdersRoutes, type RunOrdersIngest } from "./orders-routes.js";
import { registerOrderReminderRoutes, type OrderReminderRunDeps } from "./order-reminder-routes.js";
import { registerMailLogRoutes } from "./mail-log-routes.js";
import { registerMailTemplateRoutes } from "./mail-template-routes.js";
import { registerNedostupneRoutes, type NedostupneRunDeps } from "./nedostupne-routes.js";
import { registerNoteRoutes } from "./note-routes.js";
import { registerOrderFlagsRoutes } from "./order-flags-routes.js";
import { registerOrderMergeRoutes, type OrderMergeRunDeps } from "./order-merge-routes.js";
import { requireSameOrigin } from "./origin-check.js";
import { registerPairingRoutes } from "./pairing-routes.js";
import { registerPairingReviewRoutes } from "./pairing-review-routes.js";
import { registerPairingSearchRoutes } from "./pairing-search-routes.js";
import type { SearchClient } from "../modules/pairing-search/client.js";
import { registerPostaUncollectedRoutes, type PostaUncollectedRunDeps } from "./posta-uncollected-routes.js";
import { registerProductLinksRoutes } from "./product-links-routes.js";
import { registerProductDetailRoutes } from "./product-detail-routes.js";
import { registerSearchRoutes } from "./search-routes.js";
import { registerShopSitemapRoutes } from "./shop-sitemap-routes.js";
import type { PageFetcher, PageFetchResult } from "../modules/supplier-stock/page-fetcher.js";
import { registerSupplierStockRoutes } from "./supplier-stock-routes.js";
import { registerRestockRoutes, type RestockRunDeps } from "./restock-routes.js";
import { shoptetImportConfigFromBaseUrl } from "../modules/shoptet-writeback/config.js";
import { registerSchedulerRoutes } from "./scheduler-routes.js";
import { registerSupplierRoutes } from "./supplier-routes.js";
import { registerThemeColorRoutes } from "./theme-color-routes.js";
import { registerUpozorneniaRoutes } from "./upozornenia-routes.js";

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
    readonly sendSupplierMail?: MailTransport;
    // issue 65: `env.ts`'s `SHOPTET_ADMIN_BASE_URL` — má vždy hodnotu (zod
    // default), preto voliteľný parameter s vlastným defaultom tu, nie
    // `?:` ako `runIngest`/ostatné (tie chýbajú, keď zodpovedajúca URL nie
    // je nastavená; toto vždy JE nastavené, aspoň na predvolenú hodnotu).
    readonly adminBaseUrl?: string;
    // issue 172: "Spustiť teraz" + náhľad — voliteľné (rovnaký dôvod ako
    // `adminBaseUrl` vyššie: existujúce testy/lokálny vývoj bez explicitne
    // odovzdanej hodnoty dostanú rozumný default nižšie, nikdy nemusia
    // meniť svoje volanie `createApp`). `index.ts` ho v produkcii VŽDY
    // zostavuje s reálnym tracking klientom.
    readonly postaUncollected?: PostaUncollectedRunDeps;
    // issue 173: "Pripomienky objednávok" — rovnaký dôvod ako
    // `postaUncollected` vyššie: voliteľné, bezpečný default nižšie pre
    // testy/lokálny vývoj, `index.ts` v produkcii VŽDY nahradí reálnymi
    // dependencies.
    readonly orderReminder?: OrderReminderRunDeps;
    // issue 176: "Nedostupné tovary" — rovnaký dôvod ako `orderReminder`
    // vyššie: voliteľné, bezpečný default nižšie pre testy/lokálny vývoj,
    // `index.ts` v produkcii VŽDY nahradí reálnymi dependencies.
    readonly nedostupne?: NedostupneRunDeps;
    // issue 257: "Zlúčenie objednávok" — nová záložka v Eshope. Voliteľné z
    // rovnakého dôvodu ako `nedostupne` vyššie: bezpečný default pre testy/
    // lokálny vývoj, `index.ts` v produkcii VŽDY nahradí reálnymi
    // dependencies.
    readonly orderMerge?: OrderMergeRunDeps;
    // issue 212: "Dodávateľský sklad" — sťahovanie stránky dodávateľa.
    // Voliteľné z rovnakého dôvodu ako `nedostupne` vyššie; testy dodajú
    // vlastnú implementáciu a NIKDY nechodia na skutočnú stránku dodávateľa.
    readonly fetchSupplierPage?: PageFetcher;
    // issue 213: "Vypredané → Skladom" — prihlasovacie údaje do Shoptet
    // administrácie. Voliteľné z rovnakého dôvodu ako ostatné; testy
    // dodajú vlastný zápis a NIKDY sa nedotknú skutočného Shoptetu.
    readonly restock?: RestockRunDeps;
    // issue 292: "Eshop → Preprava DPD" — prihlasovacie údaje do
    // `dpdshipper.sk`. Voliteľné z rovnakého dôvodu ako `nedostupne`
    // vyššie; `config: undefined` (predvolené nižšie) = appka beží ďalej,
    // len akcie odosielajúce do DPD vrátia 503 "nenakonfigurované" namiesto
    // tichého zápisu s prázdnymi prihlasovacími údajmi.
    readonly dpd?: DpdRunDeps;
    // issue 309: "Eshop → Upozornenia" — najbližšia udalosť z Google
    // kalendára. `undefined` (predvolené) = appka beží ďalej, karta na
    // nástenke sa jednoducho nezobrazí (rovnaký "configured" vzor ako `dpd`
    // vyššie) — `index.ts` ju v produkcii nahradí LEN keď je nastavená
    // `GOOGLE_CALENDAR_ICS_URL` (`env.ts`).
    readonly nextEvent?: NextEventService;
    // issue 422: "Živé ceny/dostupnosť" — voliteľný `SearchClient` pre
    // `GET /api/pairing-review/live-supplier-info`. Rovnaký dôvod ako
    // `fetchSupplierPage`/`restock` vyššie: `undefined` necháva
    // `registerPairingReviewRoutes`'s vlastný default (REÁLNy klient,
    // rovnaký vzor ako `pairing-search/run.ts`) — testy dodajú vlastný s
    // injektovaným `Fetcher`, NIKDY nechodia na skutočnú sieť.
    readonly pairingSearchClient?: SearchClient;
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

  // issue 188: ZÁMERNE bez `requireUser` — neprihlásený dostane 200 s telom
  // `null`, nie 401. Chromium totiž loguje KAŽDÚ 4xx odpoveď do konzoly ako
  // "Failed to load resource", takže úplne v poriadku fungujúca appka
  // vypisovala na prihlasovacej obrazovke červenú chybu. Je to ten istý vzor,
  // aký už má `POST /api/me/password` (očakávaný doménový výsledok = 200 s
  // telom) — 4xx si nechávame pre SKUTOČNÉ HTTP chyby. Ostatné endpointy si
  // svoju 401 ponechávajú: tie sa volajú až z prihlásenej appky, kde 401
  // znamená vypršanú reláciu a klient na nej stavia.
  app.get("/api/me", async (c) => {
    const user = await resolveSession(db, getCookie(c, SESSION_COOKIE) ?? "", new Date());
    return c.json(user);
  });

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
  // issue 65: rovnaký default ako `env.ts`'s `SHOPTET_ADMIN_BASE_URL` — testy
  // aj lokálny vývoj bez explicitne odovzdanej hodnoty dostanú tú istú
  // rozumnú predvolenú doménu, nikdy prázdny/neplatný reťazec.
  registerOrdersRoutes(app, db, options.runOrdersIngest, options.adminBaseUrl ?? "https://www.forestshop.sk");
  registerSchedulerRoutes(app, db);
  registerSupplierRoutes(app, db, options.sendSupplierMail);
  registerPairingRoutes(app, db);
  // issue 387 E3: "Profesionálne párovanie produktov" — gather beh, žiadne
  // prihlasovacie údaje netreba (SearchClient je vždy reálny, čítanie
  // verejných vyhľadávacích stránok dodávateľov), na rozdiel od
  // `restock`/`shoptet-writeback` vyššie.
  registerPairingSearchRoutes(app, db);
  // issue 402: "Adresy z sitemapy + HTTP sonda" — doplnok `shop-feed`u,
  // žiadne prihlasovacie údaje (verejná sitemapa + sonda VLASTNÉHO webu).
  registerShopSitemapRoutes(app, db);
  // issue 387 E5: "Eshop → Párovanie" — LEN čítanie nad tým, čo E3/E4
  // zozbierali/overili (karty + filtre). Rozhodnutia (E6) ešte neexistujú —
  // žiadna zapisovacia trasa tu, samostatné od `registerPairingRoutes`
  // (skrytá F4 "Kontrola párovania") aj `registerProductLinksRoutes` nižšie
  // (#239 "Párovanie produktov") — obe ostávajú nedotknuté (design komentár
  // na tickete: E9 ich prípadné vyradenie potrebuje výslovný súhlas majiteľa).
  registerPairingReviewRoutes(app, db, options.pairingSearchClient);
  // issue 239: "Eshop → Párovanie produktov" — zoznam produktov bez
  // dodávateľskej linky + doplnenie/oprava (zapisuje do rovnakej
  // `product_supplier_link_override` tabuľky ako #121, žiadna nová cesta do
  // Shoptetu).
  registerProductLinksRoutes(app, db);
  // issue 240: "Eshop → Vyhľadať" — hľadanie naprieč katalógom + objednávkami,
  // a detail produktu (za výsledkom hľadania) so VŠETKÝMI jeho variantmi.
  // Editácia dodávateľskej linky ide cez existujúcu `registerProductLinksRoutes`
  // trasu vyššie (#239) — žiadna nová zapisovacia cesta.
  registerProductDetailRoutes(app, db);
  registerSearchRoutes(app, db, options.adminBaseUrl ?? "https://www.forestshop.sk");
  registerPostaUncollectedRoutes(
    app,
    db,
    options.postaUncollected ?? {
      // Bezpečný default pre testy/lokálny vývoj bez explicitne dodaných
      // dependencies — NIKDY nekontaktuje skutočné api.posta.sk (vracia
      // `null`, "zlyhalo", presne ako sieťový výpadok), nikdy neposiela
      // mail (`mailTransport` chýba). Produkcia (`index.ts`) toto VŽDY
      // nahradí reálnym tracking klientom.
      trackingClient: () => Promise.resolve(null),
      mailTransport: undefined,
      bccEmail: undefined,
      adminBaseUrl: options.adminBaseUrl ?? "https://www.forestshop.sk",
    },
  );
  registerOrderReminderRoutes(
    app,
    db,
    options.orderReminder ?? {
      // Bezpečný default pre testy/lokálny vývoj bez explicitne dodaných
      // dependencies — NIKDY nekontaktuje skutočné OpenAI (`classifyClient`
      // chýba), nikdy neposiela mail (`mailTransport` chýba). Produkcia
      // (`index.ts`) toto VŽDY nahradí reálnymi dependencies.
      classifyClient: undefined,
      mailTransport: undefined,
      bccEmail: undefined,
      adminBaseUrl: options.adminBaseUrl ?? "https://www.forestshop.sk",
    },
  );
  registerNedostupneRoutes(
    app,
    db,
    options.nedostupne ?? {
      // Bezpečný default pre testy/lokálny vývoj bez explicitne dodaných
      // dependencies — NIKDY neposiela mail (`mailTransport` chýba).
      // Produkcia (`index.ts`) toto VŽDY nahradí reálnymi dependencies.
      mailTransport: undefined,
      bccEmail: undefined,
      adminBaseUrl: options.adminBaseUrl ?? "https://www.forestshop.sk",
    },
  );
  // issue 257: "Zlúčenie objednávok" — bezpečný default z rovnakého dôvodu
  // ako `nedostupne` vyššie.
  registerOrderMergeRoutes(
    app,
    db,
    options.orderMerge ?? {
      mailTransport: undefined,
      bccEmail: undefined,
    },
  );

  // issue 192: upraviteľné znenia e-mailov (obrazovka "Texty e-mailov").
  registerMailTemplateRoutes(app, db);
  // issue 264: upraviteľné farby bublinek dodávateľov (koliesko v Topbar).
  registerThemeColorRoutes(app, db);
  // issue 193: kniha odoslaných e-mailov (len čítanie) — zapisujú do nej samy
  // odosielacie cesty cez `mail-log/service.ts`.
  registerMailLogRoutes(app, db, options.adminBaseUrl ?? "https://www.forestshop.sk");
  // issue 212: "Dodávateľský sklad" — bez dodanej implementácie sa stránky
  // NEsťahujú vôbec (bezpečný default pre testy aj lokálny vývoj: hlási
  // zlyhanie kontroly, nikdy nepredstiera dostupnosť).
  registerSupplierStockRoutes(
    app,
    db,
    options.fetchSupplierPage ??
      ((): Promise<PageFetchResult> =>
        Promise.resolve({
          ok: false,
          html: "",
          httpStatus: null,
          error: "Sťahovanie stránok dodávateľa nie je nakonfigurované.",
        })),
  );
  // issue 213: bez dodanej konfigurácie sa do Shoptetu NEZAPISUJE — beh
  // skončí chybou prihlásenia, nikdy tichým "prepnuté".
  registerRestockRoutes(
    app,
    db,
    options.restock ?? {
      // Prázdne prihlasovacie údaje = beh sa zastaví na prihlásení do
      // Shoptetu a vráti chybu. Fail-closed: nikdy tiché "prepnuté".
      config: shoptetImportConfigFromBaseUrl(options.adminBaseUrl ?? "https://www.forestshop.sk", "", ""),
    },
  );

  // issue 267: "Eshop → Upozornenia" — nástenka + vlastné poznámky + zdieľaná
  // zapisovacia cesta, ktorú neskôr zavolajú #268/#269. Žiadny voliteľný
  // dependency (na rozdiel od nedostupne/orderReminder vyššie) — táto
  // obrazovka neposiela mail ani nekontaktuje tretiu stranu.
  registerUpozorneniaRoutes(app, db);
  registerDailyTasksRoutes(app, db);
  // issue 437: "Poznámky" — ZDIEĽANÁ nástenka rýchlych poznámok (mobilný
  // zápis + PWA). Žiadny voliteľný dependency (na rozdiel od nedostupne/
  // orderReminder vyššie) — neposiela mail ani nekontaktuje tretiu stranu,
  // rovnako ako `registerUpozorneniaRoutes`/`registerDailyTasksRoutes`.
  registerNoteRoutes(app, db);
  // issue 309: rovnaká nástenka, ale NEZÁVISLÝ modul (žiadny dedupKey/
  // resolve/postpone — `upozornenia.md`'s návrhový komentár na tickete).
  registerCalendarRoutes(app, db, options.nextEvent);
  // issue 290: "Eshop → Výmena tovaru / Vrátený tovar / Reklamácie" — tri
  // READ-ONLY pohľady + appkina vlastná reklamácia-značka. Žiadny voliteľný
  // dependency (rovnaký dôvod ako `upozornenia` vyššie).
  registerOrderFlagsRoutes(app, db, options.adminBaseUrl ?? "https://www.forestshop.sk");
  // issue 410: "Eshop → Objednávky predajňa" — nahrádza Shoptet-viazaný
  // `registerFloorOrdersRoutes` (issue 345) vlastnými zápismi z predajne.
  // Zápis (vytvoriť/upraviť/zmazať/prepnúť značku/pripnúť-odopnúť produkt)
  // je gejtovaný `requireRole("admin","manazer")` PRIAMO v
  // `floor-notes-routes.ts`, žiadny extra dependency tu netreba.
  registerFloorNotesRoutes(app, db);
  // issue 292: "Eshop → Preprava DPD" — bez dodanej konfigurácie sa do DPD
  // NEODOSIELA vôbec (fail-closed, rovnaký princíp ako `restock`/
  // `nedostupne` vyššie): akcie vrátia 503 "nenakonfigurované".
  registerDpdRoutes(app, db, options.dpd ?? { config: undefined });

  // Musí byť registrovaný AŽ PO všetkých skutočných /api/* trasách vyššie — Hono
  // vyberá presnejšiu zhodu, takže tie majú prednosť a sem sa dostane len to, čo
  // nesedí na žiadnu z nich. Bez tohto by neznáma /api/* cesta spadla až na SPA
  // fallback (serveStatic index.html) pridaný v index.ts a tichým 200 by
  // schovala preklep v ceste namiesto viditeľnej chyby.
  app.all("/api/*", (c) => c.json({ error: "Nenájdená API cesta" }, 404));

  return app;
}
