import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import type { CatalogIngestResult, RunIngest } from "../modules/catalog/ingest.js";
import { catalogStats, getVariant, listSnapshots, searchVariants } from "../modules/catalog/queries.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

const snapshotsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

// Prázdna hodnota (`page=`) sa má správať ako neprítomný parameter (predvolená
// prvá strana), nie ako `Number("") === 0`, ktoré padne na `min(1)` a vráti 400
// — preto `z.preprocess` najprv premení `""` na `undefined`. Horný strop
// 100 000 drží `(page - 1) * pageSize` (pageSize najviac 200) pod
// ~20 000 000 — bezpečné celé číslo, ktoré Postgres offset prijme bez chyby.
// Bez stropu napr. `page=1e21` vyrobí offset `2e+23`, ktorý Postgres odmietne
// s "invalid input syntax for type bigint" a ten uniká ako 500 namiesto 400
// (review task-6-fix-1).
const pageParam = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().min(1).max(100_000).default(1),
);

const variantsQuery = z.object({
  q: z.string().max(200).default(""),
  state: z.enum(["all", "sellable", "out_of_stock", "discontinued", "missing"]).default("all"),
  page: pageParam,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const variantParam = z.object({ code: z.string().min(1).max(100) });

// Re-exportované, aby `http/app.ts` nemusel meniť svoj import — kanonická
// definícia žije v `modules/catalog/ingest.ts` (viď komentár tam).
export type { RunIngest };

export function registerCatalogRoutes(
  app: Hono<AppBindings>,
  db: Database,
  runIngest: RunIngest | undefined,
): void {
  app.get("/api/catalog/stats", requireUser(db), async (c) => c.json(await catalogStats(db)));

  app.get("/api/catalog/snapshots", requireUser(db), zValidator("query", snapshotsQuery), async (c) =>
    c.json({ items: await listSnapshots(db, c.req.valid("query").limit) }),
  );

  app.get("/api/catalog/variants", requireUser(db), zValidator("query", variantsQuery), async (c) =>
    c.json(await searchVariants(db, c.req.valid("query"))),
  );

  app.get(
    "/api/catalog/variants/:code",
    requireUser(db),
    zValidator("param", variantParam),
    async (c) => {
      const variant = await getVariant(db, c.req.valid("param").code);
      if (variant === null) return c.json({ error: "Variant sa nenašiel" }, 404);
      // Nákupná cena je marža — vidí ju každá rola OKREM čisto čitateľskej
      // ("citanie"); ostatné polia zostávajú rovnaké pre všetkých. Zámerná
      // odchýlka od pôvodného zadania (review task-6-fix-1).
      if (c.get("user").role === "citanie") return c.json({ ...variant, purchasePrice: null });
      return c.json(variant);
    },
  );

  // JEDEN import naraz — druhé spustenie počas behu prvého vráti "busy"
  // namiesto toho, aby odštartovalo paralelný 54 MB import nad tou istou
  // databázou (review task-6-fix-1). Uzáver na inštanciu aplikácie —
  // `createApp`/`registerCatalogRoutes` sa volá raz za proces.
  let ingestInFlight = false;

  app.post(
    "/api/catalog/ingest",
    // CSRF obrana beží PRED autentifikáciou — rovnaká `requireSameOrigin`, akú
    // F0 dáva pred `/api/logout` (origin-check.ts). F1 pridáva presne ten
    // druhý stavovo-meniaci endpoint, na ktorý F0 komentár upozorňoval, že
    // ešte príde (review task-6-fix-1).
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    async (c) => {
      if (runIngest === undefined) {
        return c.json({ error: "Import katalógu nie je nakonfigurovaný (chýba SHOPTET_EXPORT_URL)" }, 503);
      }
      if (ingestInFlight) {
        return c.json({ status: "busy" as const });
      }
      ingestInFlight = true;
      try {
        const now = new Date();
        const user = c.get("user");
        let result: CatalogIngestResult;
        try {
          result = await runIngest(now);
        } catch (error) {
          // Stiahnutie exportu zlyhalo úplne (vypršaný prihlasovací údaj, 502
          // od Shoptetu, timeout) — fetcher vyhodí PRED akýmkoľvek zápisom, teda
          // pred `ingest.ts`'s vlastným snapshot/audit/anomáliovým záznamom.
          // Predtým to táto trasa nechytala vôbec: prehliadač dostal generický
          // 500 a operátor mal k dispozícii len riadok v kontajnerovom logu —
          // toto je jediná trieda zlyhania vo fáze, ktorá nezanechala ŽIADEN
          // záznam, a v reálnej prevádzke aj najpravdepodobnejšia (review
          // final-wave-a, položka 4). Surová (možno anglická/technická) chyba
          // sa loguje TU, samostatne — nikdy sa neinterpoluje do hlášky pre
          // operátora ani do auditového záznamu, rovnaká disciplína ako pri
          // materializačnom zlyhaní v `ingest.ts`.
          const rawErrorMessage = error instanceof Error ? error.message : String(error);
          log.error(
            { actorUserId: user.userId, rawErrorMessage },
            "stiahnutie exportu katalógu zlyhalo",
          );
          await record(db, {
            at: now,
            actorUserId: user.userId,
            action: "catalog.ingest.trigger",
            entity: "catalog_snapshot",
            data: { status: "fetch_failed" },
          });
          // 502 ("stiahnutie od Shoptetu zlyhalo"), nie 500 ("tento server je
          // rozbitý") — rovnaká sémantika ako zlá brána k inému serveru.
          return c.json(
            { error: "Export zo Shoptetu sa nepodarilo stiahnuť. Skúste import o chvíľu zopakovať." },
            502,
          );
        }
        // Audit sa zapisuje PO dobehnutí importu, nie pred ním — nesie tak
        // skutočný výsledok (status + snapshotId), nielen úmysel spustiť
        // (review task-6-fix-1). `snapshotId` má aj "rejected"/"duplicate"
        // výsledok (CatalogIngestResult, ingest.ts), takže je vždy k dispozícii.
        await record(db, {
          at: now,
          actorUserId: user.userId,
          action: "catalog.ingest.trigger",
          entity: "catalog_snapshot",
          entityId: result.snapshotId,
          data: { status: result.status, snapshotId: result.snapshotId },
        });
        log.info({ actorUserId: user.userId, status: result.status }, "ručný import katalógu");
        return c.json(result);
      } finally {
        ingestInFlight = false;
      }
    },
  );
}
