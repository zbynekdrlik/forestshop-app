import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { listPairings } from "../modules/pairing/queries.js";
import { confirmPairing } from "../modules/pairing/state.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

// Prázdna hodnota (`page=`) sa má správať ako neprítomný parameter, rovnaký
// vzor ako `catalog-routes.ts`'s `pageParam` — inak `Number("") === 0` padne
// na `min(1)` a vráti 400 namiesto predvolenej prvej strany.
const pageParam = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().min(1).max(100_000).default(1),
);

const pairingQuery = z.object({
  q: z.string().max(200).default(""),
  state: z.enum(["all", "navrhnute", "potvrdene"]).default("all"),
  page: pageParam,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// `variantCode` ide v TELE, nie v ceste — kódy variantov nesú lomku
// (napr. "40237/3XL"), ktorá by ako cestový segment bola prinajlepšom
// krehká (viď návrhový komentár na issue 45). `supplierUrl` je voliteľné:
// prítomné → ručne zadaná/opravená adresa (prepíše uloženú a rovno potvrdí);
// chýbajúce → potvrdenie AKTUÁLNE uloženej/navrhnutej adresy.
const confirmPairingBody = z.object({
  variantCode: z.string().min(1).max(100),
  supplierUrl: z.string().trim().min(1).max(2000).url().optional(),
});

export function registerPairingRoutes(app: Hono<AppBindings>, db: Database): void {
  // Čítanie — rovnaké oprávnenie ako katalóg/objednávky (`requireUser`, žiadne
  // obmedzenie roly): každý prihlásený smie vidieť stav párovania, len
  // POTVRDZOVANIE (nižšie) je vyhradené.
  app.get("/api/pairing", requireUser(db), zValidator("query", pairingQuery), async (c) =>
    c.json(await listPairings(db, c.req.valid("query"))),
  );

  // Potvrdenie páru (jedným klikom, s alebo bez ručne zadanej novej adresy) —
  // rovnaké oprávnenie ako zmena stavu riadku objednávky
  // (`requireRole("admin", "manazer")`): manažér páruje, `citanie`/`sef` len
  // čítajú.
  app.post(
    "/api/pairing/confirm",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", confirmPairingBody),
    async (c) => {
      const body = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();

      const result = await confirmPairing(db, {
        variantCode: body.variantCode,
        supplierUrl: body.supplierUrl,
        actorUserId: user.userId,
        now,
      });
      if (result === "not_found") {
        return c.json({ error: "Variant sa nenašiel" }, 404);
      }
      if (result === "missing_url") {
        return c.json({ error: "Chýba adresa produktu u dodávateľa" }, 400);
      }
      log.info(
        { actorUserId: user.userId, variantCode: body.variantCode, manualOverride: body.supplierUrl !== undefined },
        "potvrdenie párovania variantu",
      );
      return c.json({ ok: true as const });
    },
  );
}
