import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { getProductDetail } from "../modules/product-detail/queries.js";
import { requireUser, type AppBindings } from "./middleware.js";

// issue 240: rovnaké oprávnenie ako `/api/product-links` (#239) —
// `requireUser`, žiadne obmedzenie roly, čítanie smie vidieť každý prihlásený.
// Editácia dodávateľskej linky ide cez EXISTUJÚcu trasu
// `POST /api/product-links/:productKey` (#239) — táto trasa je len na čítanie.
const productKeyParam = z.object({ productKey: z.string().min(1).max(200) });

export function registerProductDetailRoutes(app: Hono<AppBindings>, db: Database): void {
  app.get(
    "/api/product-detail/:productKey",
    requireUser(db),
    zValidator("param", productKeyParam),
    async (c) => {
      const { productKey } = c.req.valid("param");
      const detail = await getProductDetail(db, productKey);
      if (detail === null) return c.json({ error: "Produkt sa nenašiel" }, 404);
      return c.json(detail);
    },
  );
}
