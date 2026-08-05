import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { record } from "../modules/audit/service.js";
import type { MailTransport } from "../modules/mail/transport.js";
import { consumeMergePreviewToken, issueMergePreviewToken } from "../modules/orders/merge-mail-preview-tokens.js";
import { buildOrderMergeMailContent, listMergeCandidateGroups, sendOrderMergeMail } from "../modules/orders/merge-mail.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

// issue 257: "Zlúčenie objednávok" — nová záložka v Eshope (majiteľova
// korekcia zadania), rovnaký HTTP vzor ako `nedostupne-routes.ts` (povinný
// server-side vynútený náhľad pred odoslaním, `.claude/rules/nedostupne.md`).
export interface OrderMergeRunDeps {
  readonly mailTransport: MailTransport | undefined;
  readonly bccEmail: string | undefined;
}

const previewBody = z.object({ baseOrderId: z.string().uuid(), otherOrderIds: z.array(z.string().uuid()).min(1) });
// `/send` musí priniesť token vydaný `/preview` PRE PRESNE tento (baseOrderId,
// zoradený výber) — rovnaká disciplína ako `nedostupne-routes.ts`.
const sendBody = previewBody.extend({ previewToken: z.string().min(1) });

function bccMissing(deps: OrderMergeRunDeps): boolean {
  return deps.bccEmail === undefined || deps.bccEmail.trim() === "";
}

function mailNotConfigured(deps: OrderMergeRunDeps): boolean {
  return deps.mailTransport === undefined;
}

type SendMergeMailFailure = Exclude<Awaited<ReturnType<typeof sendOrderMergeMail>>, { readonly status: "sent" }>;

function sendErrorMessage(result: SendMergeMailFailure): string {
  switch (result.status) {
    case "not_found":
      return "Objednávka sa v aktuálnom zozname nenašla — pravdepodobne sa medzitým zmenil jej stav.";
    case "invalid_selection":
      return "Vybraný zoznam objednávok už nesedí s aktuálnym stavom — obnovte stránku a skúste znova.";
    case "no_email":
      return "Zákazník nemá e-mailovú adresu.";
    case "not_configured":
      return result.reason;
    case "send_failed":
      return "Odoslanie e-mailu zlyhalo — skúste to znova.";
  }
}

export function registerOrderMergeRoutes(app: Hono<AppBindings>, db: Database, deps: OrderMergeRunDeps): void {
  // Čítanie — každý prihlásený zamestnanec (rovnaká úroveň ako "Nedostupné
  // tovary").
  app.get("/api/order-merge/candidates", requireUser(db), async (c) => {
    const groups = await listMergeCandidateGroups(db);
    return c.json({ groups, bccMissing: bccMissing(deps), mailNotConfigured: mailNotConfigured(deps) });
  });

  // Povinný náhľad — počítaný ROVNAKOU funkciou, akú použije skutočné
  // odoslanie nižšie (`nedostupne-routes.ts`'s vzor), a VYDÁ jednorazový
  // token.
  app.post(
    "/api/order-merge/preview",
    requireSameOrigin(),
    requireUser(db),
    zValidator("json", previewBody),
    async (c) => {
      const { baseOrderId, otherOrderIds } = c.req.valid("json");
      const built = await buildOrderMergeMailContent(db, baseOrderId, otherOrderIds);
      if (!built.ok) {
        // 200 (nikdy 404) — rovnaká disciplína ako `nedostupne-routes.ts`
        // (`.claude/rules/testing.md`'s Chromium console-error pravidlo).
        const error =
          built.error === "not_found"
            ? "Objednávka sa v aktuálnom zozname nenašla — pravdepodobne sa medzitým zmenil jej stav."
            : "Vybraný zoznam objednávok už nesedí s aktuálnym stavom — obnovte stránku a skúste znova.";
        return c.json({ ok: false as const, error });
      }
      const previewToken = issueMergePreviewToken(baseOrderId, otherOrderIds, new Date());
      return c.json({
        ok: true as const,
        subject: built.content.subject,
        html: built.content.html,
        recipient: built.content.to ?? "",
        customerName: built.content.customerName,
        orderNumbers: built.content.orderNumbers,
        previewToken,
      });
    },
  );

  // Odoslanie — mutuje (zapíše do Knihy odoslaných e-mailov), rovnaká rola
  // ako "Nedostupné tovary"'s odoslanie (admin/manazer).
  app.post(
    "/api/order-merge/send",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", sendBody),
    async (c) => {
      const { baseOrderId, otherOrderIds, previewToken } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      // Server-side vynútenie povinného náhľadu — token sa KONZUMUJE
      // (zmaže) hneď, bez ohľadu na výsledok.
      if (!consumeMergePreviewToken(previewToken, baseOrderId, otherOrderIds, now)) {
        return c.json({ ok: false as const, error: "Najprv si otvorte náhľad e-mailu — bez neho appka nepošle nič." });
      }
      const result = await sendOrderMergeMail({
        db,
        now,
        baseOrderId,
        otherOrderIds,
        mailTransport: deps.mailTransport,
        bccEmail: deps.bccEmail,
        actorUserId: user.userId,
      });
      if (result.status !== "sent") {
        return c.json({ ok: false as const, error: sendErrorMessage(result) });
      }
      // issue 257: žiadna vlastná dedup/stavová tabuľka pre túto
      // automatizáciu (rozhodnuté v návrhovom komentári na tickete) —
      // `entity`/`entityId` preto vzorujú `supplier-routes.ts`'s
      // `orders.mail.send` (mailová akcia bez vlastnej mutovanej tabuľky,
      // nie `nedostupne.send`'s `nedostupne_state`, kde entity sedí presne
      // preto, lebo TA tabuľka sa reálne mení).
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "order_merge.send",
        entity: "order",
        entityId: baseOrderId,
        data: { baseOrderId, otherOrderIds, orderNumbers: result.orderNumbers, to: result.to },
      });
      return c.json({ ok: true as const });
    },
  );
}
