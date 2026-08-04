import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { listProductLinks } from "../modules/product-links/queries.js";
import { setProductSupplierLinkForProduct, supplierLinkUrlBody } from "../modules/orders/supplier-link-assignment.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

// Prázdna hodnota (`page=`) sa má správať ako neprítomný parameter, rovnaký
// vzor ako `catalog-routes.ts`/`pairing-routes.ts`'s `pageParam`.
const pageParam = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().min(1).max(100_000).default(1),
);

// Predvolené `state: "missing"` — ticket žiada primárne zoznam produktov BEZ
// linky; "all"/"linked" umožňujú aj OPRAVU existujúcej (ticketova akceptačná
// podmienka "existujúcu linku sa musí dať aj opraviť").
const productLinksQuery = z.object({
  q: z.string().max(200).default(""),
  state: z.enum(["all", "missing", "linked"]).default("missing"),
  page: pageParam,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// `productKey` je export's `guid` (`schema-catalog.ts`'s komentár k
// `products.key`) — UUID-tvar bez lomky, bezpečné ako cestový segment (na
// rozdiel od `variantCode`, ktorý lomku nesie, viď `pairing-routes.ts`'s
// komentár prečo TEN parameter ide v tele).
const productLinkParam = z.object({ productKey: z.string().min(1).max(200) });

export function registerProductLinksRoutes(app: Hono<AppBindings>, db: Database): void {
  // Čítanie — rovnaké oprávnenie ako katalóg/objednávky/párovanie
  // (`requireUser`, žiadne obmedzenie roly): každý prihlásený smie vidieť,
  // ktoré produkty nemajú dodávateľskú linku.
  app.get("/api/product-links", requireUser(db), zValidator("query", productLinksQuery), async (c) =>
    c.json(await listProductLinks(db, c.req.valid("query"))),
  );

  // Doplnenie/oprava linky — rovnaké oprávnenie ako existujúci
  // `POST /api/orders/lines/:lineId/supplier-link` (issue 121):
  // `requireRole("admin", "manazer")`.
  app.post(
    "/api/product-links/:productKey",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", productLinkParam),
    zValidator("json", supplierLinkUrlBody),
    async (c) => {
      const { productKey } = c.req.valid("param");
      const { url } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();

      const result = await setProductSupplierLinkForProduct(db, { productKey, url, actorUserId: user.userId, now });
      if (result === "not_found") {
        return c.json({ error: "Produkt sa nenašiel" }, 404);
      }
      log.info({ actorUserId: user.userId, productKey, url }, "úprava odkazu na dodávateľa produktu (Párovanie produktov)");
      return c.json({ ok: true as const, url });
    },
  );
}
