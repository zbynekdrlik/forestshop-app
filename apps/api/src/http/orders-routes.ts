import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { orderLineState } from "../db/schema.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { ORDERS_EXPORT_URL_NOT_CONFIGURED, type OrdersIngestResult, type RunOrdersIngest } from "../modules/orders/ingest.js";
import { listKnownStatusNames, listOpenStatusNames, replaceOpenStatusNames } from "../modules/orders/open-statuses.js";
import { getOrdersDashboardOverview } from "../modules/orders/overview.js";
import { countOpenOrdersByState, getOrderDetail, listOpenOrderLinesBySupplier } from "../modules/orders/queries.js";
import { assignOrderLineSupplier } from "../modules/orders/supplier-assignment.js";
import { setProductSupplierLink, supplierLinkUrlBody } from "../modules/orders/supplier-link-assignment.js";
import { setOrderComment, setOrderLineOrdered, setOrderLinesStateByCode, setOrderLineState } from "../modules/orders/state.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

const orderParam = z.object({ id: z.string().uuid() });
const orderLineParam = z.object({ lineId: z.string().uuid() });
// Čerpané priamo z `orderLineState.enumValues` (zdieľaný zdroj pravdy so
// schémou, `schema-orders.ts`) — nikdy ručne prepísaná únia, ktorá by sa mohla
// rozísť pri pridaní ďalšieho stavu.
const orderLineStateBody = z.object({ state: z.enum(orderLineState.enumValues) });
// issue 60: odškrtávacie políčko "objednané u dodávateľa".
const orderLineOrderedBody = z.object({ ordered: z.boolean() });
// issue 63: ručné priradenie dodávateľa — orezané + neprázdne; case sa
// NEFOLDUJE (presne to, čo manažér napísal, sa uloží, `supplier-key.ts`'s
// komentár k `normalizeSupplierKeyJs` vysvetľuje prečo). `.max(200)` (issue 86,
// nezávislý audit): rovnaká horná hranica ako ostatné voľné textové vstupy
// v projekte (`catalog-routes.ts`, `pairing-routes.ts`) — hodnota sa neskôr
// vkladá aj do mailu dodávateľovi, chýbajúci limit bol prehliadnutá medzera.
const orderLineSupplierBody = z.object({ supplier: z.string().trim().min(1).max(200) });
// issue 121/153: validácia tela presunutá do `supplier-link-assignment.ts`'s
// zdieľaného `supplierLinkUrlBody` (issue 239 ju potrebuje ZNOVA pre
// `POST /api/product-links/:productKey`, rovnaká URL+http(s)+formula-guard
// kontrola) — pôvodný komentár k dôvodu jednotlivých pravidiel je tam.
const orderLineSupplierLinkBody = supplierLinkUrlBody;
// issue 64: manažérova voľná poznámka k CELEJ objednávke — na rozdiel od
// `orderLineSupplierBody` vyššie ZÁMERNE bez `.min(1)` (prázdny orezaný vstup
// je platný spôsob, ako poznámku vymazať, route ho mapuje na `null`). Cap
// 2000 znakov — rovnaká horná hranica ako legacy appka's `ORDER_COMMENT_MAX`
// (`parovanie_produktov/webreview/app.py`, čítané len pre správanie).
const orderCommentBody = z.object({ comment: z.string().trim().max(2000) });
// issue 59: `min(1)` len zachytí zjavne prázdny request skôr, než sa vôbec
// dostane k `replaceOpenStatusNames` — SKUTOČNÉ čistenie (normalizácia,
// orezanie prázdnych/duplicít po trime) beží až v module, lebo "['   ']"
// prejde touto schémou, ale po očistení je to prázdny zoznam.
const openStatusesBody = z.object({ statuses: z.array(z.string()).min(1).max(50) });
// issue 476: rýchle pole v sekcii Riešiť — číslo objednávky (`externalOrderId`,
// orezané + neprázdne). Cap 50 (rovnaká horná hranica ako `open_status`
// položka vyššie) — Shoptet čísla objednávok sú krátke, toto len zachytí
// zjavne pokazený vstup skôr, než sa dostane k DB dopytu.
const riesitByCodeBody = z.object({ code: z.string().trim().min(1).max(50) });

// Re-exportované, aby `http/app.ts` nemusel meniť svoj import — kanonická
// definícia žije v `modules/orders/ingest.ts` (rovnaký vzor ako katalógov
// `RunIngest` re-export v `catalog-routes.ts`).
export type { RunOrdersIngest };

export function registerOrdersRoutes(
  app: Hono<AppBindings>,
  db: Database,
  runOrdersIngest: RunOrdersIngest | undefined,
  // issue 65: `env.ts`'s `SHOPTET_ADMIN_BASE_URL` — základ priameho odkazu
  // do Shoptet administrácie pri každom riadku (`queries.ts`'s
  // `buildShoptetAdminOrderUrl`).
  adminBaseUrl: string,
): void {
  // Čítacie trasy — rovnaké oprávnenie ako katalógové čítanie
  // (`requireUser`, žiadne obmedzenie roly): každý prihlásený používateľ smie
  // vidieť otvorené objednávky, len SPÚŠŤANIE importu (nižšie) je vyhradené.
  app.get("/api/orders/open", requireUser(db), async (c) =>
    c.json({ suppliers: await listOpenOrderLinesBySupplier(db, adminBaseUrl) }),
  );

  // issue 476: sekcia „Riešiť" — PRESNE tie isté zoskupené riadky ako
  // „Na objednanie", len zúžené na stav `riesit` (zdieľaný
  // `listOpenOrderLinesBySupplier` so `stateFilter`, žiadna duplicita).
  // Literálne trasy `/api/orders/riesit(...)` MUSIA byť PRED `GET /api/orders/
  // :id` nižšie — Hono zhoduje v poradí registrácie, inak by parametrizovaná
  // `:id` „riesit" zožrala ako svoj parameter (`.claude/rules/http-routes.md`,
  // rovnaký dôvod ako „open-statuses"/„overview" vyššie).
  app.get("/api/orders/riesit", requireUser(db), async (c) =>
    c.json({ suppliers: await listOpenOrderLinesBySupplier(db, adminBaseUrl, { stateFilter: "riesit" }) }),
  );

  // issue 476/484: odznak počtu v ľavom menu — počet otvorených DISTINCT
  // OBJEDNÁVOK v stave `riesit` (issue 484, Štěpán: „koľko problémových
  // objednávok", nie riadkov). `requireUser`, žiadne obmedzenie roly (čítanie
  // počtu nie je citlivejšie než čítanie zoznamu).
  app.get("/api/orders/riesit/count", requireUser(db), async (c) => {
    const count = await countOpenOrdersByState(db, "riesit");
    return c.json({ count });
  });

  // issue 476: rýchle pole „číslo objednávky → Enter" — nastaví stav `riesit`
  // na VŠETKÝCH riadkoch danej (otvorenej) objednávky. Rovnaké oprávnenie +
  // CSRF disciplína ako per-riadková zmena stavu (`requireRole("admin",
  // "manazer")`). Neznáme/zatvorené číslo = zrozumiteľná SK chyba (400).
  app.post(
    "/api/orders/riesit/by-code",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", riesitByCodeBody),
    async (c) => {
      const { code } = c.req.valid("json");
      const user = c.get("user");
      const result = await setOrderLinesStateByCode(db, {
        code,
        newState: "riesit",
        actorUserId: user.userId,
        now: new Date(),
      });
      // Neznáme/zatvorené číslo je BEŽNÝ, OČAKÁVANÝ používateľský omyl (preklep
      // v čísle), nie HTTP chyba — vraciame 200 s `{ok:false,error}`, nie 4xx.
      // Chromium loguje „Failed to load resource" pre KAŽDÝ fetch s 4xx, čo by
      // pri rýchlom poli (overovanom cez Playwright s kontrolou nulovej konzoly)
      // porušilo zákaz konzolových chýb (`.claude/rules/testing.md`, rovnaký
      // vzor ako `/api/catalog/ingest`'s `{status:"busy"}` a `/api/me/password`).
      // Naživo overené (post-deploy 0.3.0-dev.278): 400 SKUTOČNE zalogovalo
      // konzolovú chybu na prode — preto táto oprava.
      if (result.status === "order_not_found") {
        return c.json({ ok: false as const, error: `Objednávka s číslom „${code}" sa nenašla.` });
      }
      if (result.status === "order_not_open") {
        return c.json({ ok: false as const, error: `Objednávka „${code}" už nie je otvorená — nedá sa presunúť do Riešiť.` });
      }
      log.info({ actorUserId: user.userId, code, lineCount: result.lineCount }, "hromadné označenie objednávky stavom Riešiť");
      return c.json({ ok: true as const, lineCount: result.lineCount });
    },
  );

  // issue 237: "Prehľad e-shopu" (dnes/tento týždeň/tento mesiac) — literálna
  // cesta, MUSÍ byť zaregistrovaná PRED `GET /api/orders/:id` nižšie
  // (`.claude/rules/http-routes.md`'s past, rovnaký dôvod ako
  // "open-statuses" pod týmto komentárom). Rovnaké oprávnenie ako zvyšok
  // čítania na tejto obrazovke (`requireUser`, žiadne obmedzenie roly).
  app.get("/api/orders/overview", requireUser(db), async (c) => c.json(await getOrdersDashboardOverview(db, new Date())));

  // issue 59: nastavenie, ktoré Shoptet stavy sa počítajú ako "objednávka sa
  // ešte vybavuje" (rozhoduje o obsahu `/api/orders/open` vyššie). MUSÍ byť
  // zaregistrované PRED `/api/orders/:id` nižšie — Hono zhoduje trasy v
  // poradí registrácie, takže parametrizovaná `:id` by inak "open-statuses"
  // zožrala ako svoj parameter (zlyhala by na neplatnom UUID) skôr, než by
  // sa vôbec dostalo k tejto konkrétnej ceste (zistené naživo, e2e beh).
  //
  // Čítanie má rovnaké oprávnenie ako zvyšok obrazovky (`requireUser`, žiadne
  // obmedzenie roly) — vidieť nastavenie nie je citlivejšie než vidieť
  // samotné otvorené objednávky.
  app.get("/api/orders/open-statuses", requireUser(db), async (c) => {
    const [statuses, knownStatuses] = await Promise.all([listOpenStatusNames(db), listKnownStatusNames(db)]);
    return c.json({ statuses, knownStatuses });
  });

  // Zápis — rovnaké oprávnenie + CSRF disciplína ako zmena stavu riadku
  // objednávky (`requireRole("admin", "manazer")`).
  app.put(
    "/api/orders/open-statuses",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", openStatusesBody),
    async (c) => {
      const { statuses } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      const result = await replaceOpenStatusNames(db, { statuses, actorUserId: user.userId, now });
      if (result.status === "empty") {
        return c.json({ error: "Zoznam stavov nesmie ostať prázdny — musí obsahovať aspoň jeden stav." }, 400);
      }
      log.info({ actorUserId: user.userId, statuses: result.statuses }, "zmena nastavenia otvorených stavov objednávok");
      return c.json({ ok: true as const, statuses: result.statuses });
    },
  );

  app.get("/api/orders/:id", requireUser(db), zValidator("param", orderParam), async (c) => {
    const detail = await getOrderDetail(db, c.req.valid("param").id);
    if (detail === null) return c.json({ error: "Objednávka sa nenašla" }, 404);
    return c.json(detail);
  });

  // issue 64: manažérova voľná poznámka k CELEJ objednávke (`order.comment`,
  // stĺpec existuje od F3 (#21), import ho nikdy neprepíše — `.claude/rules/
  // orders.md`). Trojsegmentová cesta (`:id`/`comment`) sa NEKOLÍDUJE s
  // dvojsegmentovým `GET /api/orders/:id` vyššie ani so 4/5-segmentovými
  // `/api/orders/lines/...` trasami nižšie (`.claude/rules/http-routes.md`'s
  // upozornenie platí len pre trasy s ROVNAKÝM počtom segmentov). Rovnaké
  // oprávnenie ako ostatné zápisy v tomto súbore.
  app.put(
    "/api/orders/:id/comment",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", orderParam),
    zValidator("json", orderCommentBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const { comment } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      const normalizedComment = comment === "" ? null : comment;

      const result = await setOrderComment(db, {
        orderId: id,
        comment: normalizedComment,
        actorUserId: user.userId,
        now,
      });
      if (result === "not_found") {
        return c.json({ error: "Objednávka sa nenašla" }, 404);
      }
      log.info({ actorUserId: user.userId, orderId: id }, "zmena poznámky k objednávke");
      return c.json({ ok: true as const, comment: normalizedComment });
    },
  );

  // Zmena stavu riadku objednávky (#25) — rovnaké oprávnenie ako spustenie
  // importu (`requireRole("admin", "manazer")`): manažér stavy mení, `citanie`/
  // `sef` len čítajú.
  app.post(
    "/api/orders/lines/:lineId/state",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", orderLineParam),
    zValidator("json", orderLineStateBody),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { state } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();

      const result = await setOrderLineState(db, {
        lineId,
        newState: state,
        actorUserId: user.userId,
        now,
      });
      if (result === "not_found") {
        return c.json({ error: "Riadok objednávky sa nenašiel" }, 404);
      }
      log.info({ actorUserId: user.userId, lineId, state }, "zmena stavu riadku objednávky");
      return c.json({ ok: true as const, state });
    },
  );

  // issue 60: odškrtávacie políčko "objednané u dodávateľa" — NEZÁVISLÉ od
  // stavu vyššie (viď `modules/orders/state.ts`'s `setOrderLineOrdered`
  // komentár). Rovnaké oprávnenie ako zmena stavu.
  app.post(
    "/api/orders/lines/:lineId/ordered",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", orderLineParam),
    zValidator("json", orderLineOrderedBody),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { ordered } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();

      const result = await setOrderLineOrdered(db, {
        lineId,
        ordered,
        actorUserId: user.userId,
        now,
      });
      if (result === "not_found") {
        return c.json({ error: "Riadok objednávky sa nenašiel" }, 404);
      }
      log.info({ actorUserId: user.userId, lineId, ordered }, "zmena príznaku objednané riadku objednávky");
      return c.json({ ok: true as const, ordered });
    },
  );

  // issue 63: ručné priradenie dodávateľa riadku, ktorého `product.supplier`
  // je v katalógu `null` — platí pre celý PRODUKT (`assignOrderLineSupplier`),
  // nie len tento jeden riadok. Rovnaké oprávnenie ako zvyšok zápisov v
  // tomto súbore.
  app.post(
    "/api/orders/lines/:lineId/supplier",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", orderLineParam),
    zValidator("json", orderLineSupplierBody),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { supplier } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();

      const result = await assignOrderLineSupplier(db, { lineId, supplier, actorUserId: user.userId, now });
      if (result === "not_found") {
        return c.json({ error: "Riadok objednávky sa nenašiel" }, 404);
      }
      // issue 86: produkt medzitým dostal dodávateľa v katalógu (súbeh s
      // importom, alebo zabudnutá otvorená stránka) — ručné priradenie sa už
      // netýka tohto riadku, `assignOrderLineSupplier` nič nezapísala.
      // issue 89 (review PR 87): predtým sa vracalo PRED `log.info` nižšie,
      // takže odmietnutý zápis nezanechal žiadnu stopu — `warn`, lebo ide o
      // odmietnutý/zablokovaný zápis (anomália nad bežnú prevádzku), nie
      // bežný informačný záznam.
      if (result === "already_has_supplier") {
        log.warn(
          { actorUserId: user.userId, lineId, supplier },
          "odmietnuté ručné priradenie dodávateľa — produkt už má dodávateľa v katalógu",
        );
        return c.json({ error: "Produkt už má dodávateľa v katalógu — ručné priradenie nie je možné" }, 409);
      }
      log.info({ actorUserId: user.userId, lineId, supplier }, "ručné priradenie dodávateľa riadku objednávky");
      return c.json({ ok: true as const, supplier });
    },
  );

  // issue 121: manuálny odkaz na dodávateľa — na rozdiel od priradenia
  // dodávateľa vyššie (#63) tu NIE je žiadna "už má hodnotu" gate: majiteľ
  // smie odkaz upraviť aj keď Shoptet už jeden poskytuje (opravuje zlé/
  // zastarané odkazy rovnako často ako dopĺňa chýbajúce). Rovnaké oprávnenie
  // ako zvyšok zápisov v tomto súbore.
  app.post(
    "/api/orders/lines/:lineId/supplier-link",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", orderLineParam),
    zValidator("json", orderLineSupplierLinkBody),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { url } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();

      const result = await setProductSupplierLink(db, { lineId, url, actorUserId: user.userId, now });
      if (result === "not_found") {
        return c.json({ error: "Riadok objednávky sa nenašiel" }, 404);
      }
      log.info({ actorUserId: user.userId, lineId, url }, "úprava odkazu na dodávateľa riadku objednávky");
      return c.json({ ok: true as const, url });
    },
  );

  // JEDEN import naraz — rovnaký in-flight guard ako `/api/catalog/ingest`
  // (uzáver na inštanciu aplikácie, `createApp`/`registerOrdersRoutes` sa
  // volá raz za proces).
  let ingestInFlight = false;

  app.post(
    "/api/orders/ingest",
    // Rovnaká CSRF disciplína ako `/api/catalog/ingest` — stavovo-meniaca
    // požiadavka nad autentifikovaným cookie session-om.
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    async (c) => {
      if (runOrdersIngest === undefined) {
        return c.json({ error: ORDERS_EXPORT_URL_NOT_CONFIGURED }, 503);
      }
      if (ingestInFlight) {
        return c.json({ status: "busy" as const });
      }
      ingestInFlight = true;
      try {
        const now = new Date();
        const user = c.get("user");
        let result: OrdersIngestResult;
        try {
          result = await runOrdersIngest(now);
        } catch (error) {
          // Stiahnutie exportu zlyhalo úplne — rovnaká disciplína ako
          // katalógov ekvivalent (`catalog-routes.ts`): surová chyba sa
          // loguje samostatne, nikdy sa neinterpoluje do hlášky pre
          // operátora ani do auditového záznamu.
          const rawErrorMessage = error instanceof Error ? error.message : String(error);
          log.error(
            { actorUserId: user.userId, rawErrorMessage },
            "stiahnutie exportu objednávok zlyhalo",
          );
          await record(db, {
            at: now,
            actorUserId: user.userId,
            action: "orders.ingest.trigger",
            entity: "order",
            data: { status: "fetch_failed" },
          });
          return c.json(
            { error: "Export objednávok zo Shoptetu sa nepodarilo stiahnuť. Skúste import o chvíľu zopakovať." },
            502,
          );
        }
        // Audit sa zapisuje PO dobehnutí importu, nie pred ním — nesie tak
        // skutočný výsledok, nielen úmysel ho spustiť (rovnaký vzor ako
        // katalóg). Dáta sú ZÚŽENÉ (nie celý `result`) — rovnaká disciplína
        // ako katalógov `{ status, snapshotId }`: `rawPath` je cesta na
        // serverovom disku, do audit záznamu (čitateľného cez API) nepatrí.
        await record(db, {
          at: now,
          actorUserId: user.userId,
          action: "orders.ingest.trigger",
          entity: "order",
          data:
            result.status === "accepted"
              ? { status: result.status, orderCount: result.orderCount, lineCount: result.lineCount }
              : { status: result.status, reason: result.reason },
        });
        log.info({ actorUserId: user.userId, status: result.status }, "ručný import objednávok");
        return c.json(result);
      } finally {
        ingestInFlight = false;
      }
    },
  );
}
