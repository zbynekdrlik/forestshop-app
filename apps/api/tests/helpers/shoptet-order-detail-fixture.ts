import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AddressInfo } from "node:net";

/**
 * Falošný Shoptet objednávkový detail (issue 123) — imituje LEN tvar, ktorý
 * `order-note-playwright.ts` naozaj ovláda: prihlásenie (rovnaké ako #122's
 * `shoptet-fixture.ts`) a `/admin/objednavky-detail/?id=<id>` s `textarea
 * [name="shopRemark"]` + `data-testid="buttonSaveAndStay"` uloženie. Tvar
 * OVERENÝ naživo pri návrhu tohto ticketu (produkčná objednávka
 * `20261273`/`shoptet_order_id=59783`) — žiadny kontakt so skutočným
 * Shoptetom v testoch.
 */

const COOKIE_NAME = "sid";

export interface OrderDetailFixtureOptions {
  readonly user: string;
  readonly password: string;
}

export interface OrderDetailFixture {
  readonly baseUrl: string;
  /** Nastaví POČIATOČNÝ obsah `shopRemark` pre dané `id` PRED behom (napr.
   * ručne napísaný text predajne, ktorý appka nesmie prepísať). */
  seedShopRemark(id: number, text: string): void;
  getShopRemark(id: number): string | null;
  /** Review of PR 143: `id` sa vráti bez `textarea[name=shopRemark]` (napr.
   * zmazaná/nedostupná objednávka) — overuje, že `writeOneOrderNote`
   * (`order-note-playwright.ts`) TÚTO objednávku nahlási ako `ok:false` s
   * chybovým detailom, ale NEPRERUŠÍ zvyšok zoznamu. */
  breakOrder(id: number): void;
  close(): Promise<void>;
}

function loginPage(): string {
  return `<!doctype html><html><body>
    <form method="post" action="/admin/do-login">
      <input placeholder="E-mail" name="email" />
      <input placeholder="Vaše heslo" name="password" type="password" />
      <button type="submit">Prihlásenie</button>
    </form>
  </body></html>`;
}

function dashboardPage(): string {
  return `<!doctype html><html><body><h1>Nástenka</h1></body></html>`;
}

// Tvar VERNE kopíruje naživo overenú stránku: `<a>` (nie `<button>`) s
// `data-testid="buttonSaveAndStay"`, formulár submitujúci CELÚ stránku (POST
// na tú istú URL, presne ako reálny Shoptet — žiadny AJAX). Príliš
// zhovievavá fixture (napr. skutočný `<button>` s prístupným menom) by
// nechala prejsť ZLÚ implementáciu (`.claude/rules/shoptet-writeback.md`'s
// upozornenie o CSV-upload widgete platí rovnako tu).
function orderDetailPage(id: number, shopRemark: string): string {
  return `<!doctype html><html><body>
    <h2>Objednávka ${String(id)}</h2>
    <form method="post" action="/admin/objednavky-detail/?id=${String(id)}">
      <h2>Poznámka e-shopu</h2>
      <textarea name="shopRemark">${shopRemark}</textarea>
      <a href="#" data-testid="buttonSaveAndStay" onclick="this.closest('form').submit(); return false;">Uložiť</a>
    </form>
  </body></html>`;
}

// review of PR 143: simuluje objednávku, ktorá sa reálne stane nedostupnou
// (zmazaná/inak zobrazená) — stránka BEZ `textarea[name=shopRemark]`, presne
// tvar, na ktorý `writeOneOrderNote` reaguje vlastnou chybou.
function brokenOrderDetailPage(id: number): string {
  return `<!doctype html><html><body><h2>Objednávka ${String(id)} nenájdená</h2></body></html>`;
}

export async function startOrderDetailFixture(options: OrderDetailFixtureOptions): Promise<OrderDetailFixture> {
  const app = new Hono();
  const shopRemarks = new Map<number, string>();
  const brokenIds = new Set<number>();

  app.get("/admin/", (c) => {
    const cookie = getCookie(c, COOKIE_NAME);
    return c.html(cookie === "ok" ? dashboardPage() : loginPage());
  });

  app.post("/admin/do-login", async (c) => {
    const body = await c.req.parseBody();
    if (body["email"] === options.user && body["password"] === options.password) {
      setCookie(c, COOKIE_NAME, "ok", { httpOnly: true, path: "/" });
    }
    return c.redirect("/admin/", 303);
  });

  app.get("/admin/objednavky-detail/", (c) => {
    if (getCookie(c, COOKIE_NAME) !== "ok") return c.redirect("/admin/", 303);
    const id = Number(c.req.query("id"));
    if (brokenIds.has(id)) return c.html(brokenOrderDetailPage(id));
    return c.html(orderDetailPage(id, shopRemarks.get(id) ?? ""));
  });

  app.post("/admin/objednavky-detail/", async (c) => {
    if (getCookie(c, COOKIE_NAME) !== "ok") return c.redirect("/admin/", 303);
    const id = Number(c.req.query("id"));
    const body = await c.req.parseBody();
    const shopRemark = body["shopRemark"];
    // Real browsers serialize a <textarea>'s value as CRLF on form submit
    // (HTML forms spec) — naživo overený REÁLNY Shoptet už normalizuje na
    // "\n" server-side (potvrdené pri návrhu #123: read-back po uložení
    // cez čerstvú navigáciu vrátil čisté "\n", žiadne "\r"). Fixture musí
    // TÚTO normalizáciu robiť tiež, inak by prešla implementácia, ktorá by
    // proti skutočnému Shoptetu (server normalizuje) fungovala inak než
    // proti fixture (echo bez normalizácie) — presne to `.claude/rules/
    // shoptet-writeback.md`'s upozornenie o príliš zhovievavej fixture
    // varuje.
    const normalized = (typeof shopRemark === "string" ? shopRemark : "").replace(/\r\n/g, "\n");
    shopRemarks.set(id, normalized);
    return c.redirect(`/admin/objednavky-detail/?id=${String(id)}`, 303);
  });

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => {
      resolve(s as unknown as import("node:http").Server);
    });
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    seedShopRemark: (id, text) => {
      shopRemarks.set(id, text);
    },
    getShopRemark: (id) => shopRemarks.get(id) ?? null,
    breakOrder: (id) => {
      brokenIds.add(id);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
