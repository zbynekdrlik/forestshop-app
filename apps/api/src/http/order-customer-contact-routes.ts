import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { record } from "../modules/audit/service.js";
import type { MailTransport } from "../modules/mail/transport.js";
import {
  consumeCustomerContactPreviewToken,
  issueCustomerContactPreviewToken,
} from "../modules/orders/customer-contact-preview-tokens.js";
import { buildCustomerContactMail, findCustomerContactContext, sendCustomerContactMail } from "../modules/orders/customer-contact.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

// issue 500: „Na objednanie" — @ tlačidlo na riadku otvorí okno na ručný e-mail
// zákazníkovi. Rovnaký HTTP vzor ako `order-merge-routes.ts`/`nedostupne-routes.ts`
// (povinný server-side vynútený náhľad pred odoslaním, `.claude/rules/nedostupne.md`).
// Deps sú voliteľné cez `createApp` s bezpečným defaultom (mail transport a BCC
// môžu chýbať — `sendCustomerContactMail` to sama rieši fail-closed).
export interface OrderCustomerContactRunDeps {
  readonly mailTransport: MailTransport | undefined;
  readonly bccEmail: string | undefined;
}

const previewBody = z.object({ orderCode: z.string().trim().min(1).max(50) });
// issue 176/257 vzor: `/send` musí priniesť token vydaný `/preview` PRE PRESNE
// túto objednávku — server-side vynútenie „náhľad VŽDY predchádza odoslaniu"
// (`customer-contact-preview-tokens.ts`). `editedBody` je voliteľné (priame API
// bez úpravy pošle pôvodné vyrenderované znenie).
const sendBody = previewBody.extend({ previewToken: z.string().min(1), editedBody: z.string().trim().min(1).max(20000).optional() });

type SendFailure = Exclude<Awaited<ReturnType<typeof sendCustomerContactMail>>, { readonly status: "sent" }>;

function sendErrorMessage(result: SendFailure): string {
  switch (result.status) {
    case "not_found":
      return "Objednávka sa nenašla — pravdepodobne sa medzitým zmenil jej stav.";
    case "no_email":
      return "Objednávka nemá e-mailovú adresu zákazníka.";
    case "not_configured":
      return result.reason;
    case "send_failed":
      return "Odoslanie e-mailu zlyhalo — skúste to znova.";
  }
}

export function registerOrderCustomerContactRoutes(app: Hono<AppBindings>, db: Database, deps: OrderCustomerContactRunDeps): void {
  // Povinný náhľad — počítaný ROVNAKOU funkciou (`buildCustomerContactMail`),
  // akú použije skutočné odoslanie nižšie, a VYDÁ jednorazový token.
  app.post(
    "/api/order-customer-contact/preview",
    requireSameOrigin(),
    requireUser(db),
    zValidator("json", previewBody),
    async (c) => {
      const { orderCode } = c.req.valid("json");
      const ctx = await findCustomerContactContext(db, orderCode);
      if (ctx === null) {
        // 200 (nikdy 404) — rovnaká disciplína ako `order-merge`/`nedostupne`
        // (`.claude/rules/testing.md`'s Chromium console-error pravidlo).
        return c.json({ ok: false as const, error: "Objednávka sa nenašla — pravdepodobne sa medzitým zmenil jej stav." });
      }
      const built = await buildCustomerContactMail(db, ctx);
      const previewToken = issueCustomerContactPreviewToken(orderCode, new Date());
      // issue 277: `text` je plain-textová verzia (rovnaká, akú appka odošle ako
      // fallback) — frontend ju predvyplní do editovateľného okna.
      return c.json({
        ok: true as const,
        subject: built.subject,
        html: built.html,
        text: built.text,
        recipient: built.to ?? "",
        customerName: built.customerName,
        previewToken,
      });
    },
  );

  // Odoslanie — mutuje (zapíše do Knihy odoslaných e-mailov), rovnaká rola ako
  // „Nedostupné tovary"/„Zlúčenie objednávok" (admin/manazer).
  app.post(
    "/api/order-customer-contact/send",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", sendBody),
    async (c) => {
      const { orderCode, previewToken, editedBody } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      // Server-side vynútenie povinného náhľadu — token sa KONZUMUJE (zmaže)
      // hneď, bez ohľadu na výsledok, takže jeden náhľad = najviac jeden pokus.
      if (!consumeCustomerContactPreviewToken(previewToken, orderCode, now)) {
        return c.json({ ok: false as const, error: "Najprv si otvorte náhľad e-mailu — bez neho appka nepošle nič." });
      }
      const result = await sendCustomerContactMail({
        db,
        now,
        orderCode,
        mailTransport: deps.mailTransport,
        bccEmail: deps.bccEmail,
        actorUserId: user.userId,
        ...(editedBody === undefined ? {} : { editedBody }),
      });
      if (result.status !== "sent") {
        return c.json({ ok: false as const, error: sendErrorMessage(result) });
      }
      // Žiadna vlastná dedup/stavová tabuľka (rozhodnuté v návrhu) —
      // `entity`/`entityId` vzorujú `order-merge-routes.ts`'s `order_merge.send`
      // (mailová akcia bez vlastnej mutovanej tabuľky).
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "order_customer_contact.send",
        entity: "order",
        entityId: orderCode,
        data: { orderCode, to: result.to },
      });
      return c.json({ ok: true as const });
    },
  );
}
