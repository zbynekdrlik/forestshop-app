import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import type { MailTransport } from "../modules/mail/transport.js";
import { buildSupplierOrderMailContent, sendSupplierOrderMail } from "../modules/orders/mail.js";
import { setSupplierContactEmail } from "../modules/orders/supplier-contact.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

const supplierParam = z.object({ supplier: z.string().min(1) });

// Prázdny reťazec (formulár vyčistený) sa berie ako "žiadny e-mail", nie ako
// neplatná hodnota — inak by manažér nemal ako kontakt zmazať.
const setSupplierEmailBody = z.object({
  email: z.preprocess((value) => (value === "" ? null : value), z.string().email().nullable()),
});

export function registerSupplierRoutes(app: Hono<AppBindings>, db: Database, sendMail: MailTransport | undefined): void {
  // E-mailový kontakt dodávateľa (#31) — rovnaké oprávnenie ako zmena stavu
  // riadku objednávky (`requireRole("admin", "manazer")`): manažér kontakty
  // spravuje, `citanie`/`sef` len čítajú (kontakt je súčasťou
  // `GET /api/orders/open`, žiadna samostatná čítacia trasa netreba).
  app.put(
    "/api/suppliers/:supplier/email",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", supplierParam),
    zValidator("json", setSupplierEmailBody),
    async (c) => {
      const { supplier } = c.req.valid("param");
      const { email } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      await setSupplierContactEmail(db, { supplier, email, actorUserId: user.userId, now });
      log.info({ actorUserId: user.userId, supplier, hasEmail: email !== null }, "zmena e-mailu dodávateľa");
      return c.json({ ok: true as const, email });
    },
  );

  // Náhľad mailu — čisto čítacia trasa (žiadny vedľajší efekt), preto len
  // `requireUser` (rovnaké oprávnenie ako `/api/orders/open`), nie
  // `requireRole`: prezrieť si, čo by sa poslalo, nie je citlivejšie ako
  // vidieť samotné otvorené objednávky.
  app.get(
    "/api/suppliers/:supplier/order-mail",
    requireUser(db),
    zValidator("param", supplierParam),
    async (c) => {
      const { supplier } = c.req.valid("param");
      const content = await buildSupplierOrderMailContent(db, supplier);
      return c.json(content);
    },
  );

  // Odoslanie — rovnaké oprávnenie + CSRF disciplína ako zmena stavu riadku
  // objednávky. Server VŽDY prepočíta obsah zo skutočného aktuálneho stavu DB
  // (`sendSupplierOrderMail` → `buildSupplierOrderMailContent`), nikdy
  // nedôveruje telu z náhľadu. "no_email"/"no_items" sú BEŽNÉ, OČAKÁVANÉ
  // doménové výsledky (klientské tlačidlo je za rovnakých podmienok
  // disabled, toto je len obranná záloha) — rovnaký vzor ako
  // `/api/me/password`'s "zlé staré heslo": 200 s telom, nie 4xx (testing.md
  // zakazuje rozšíriť jedinú povolenú console-error výnimku). Skutočné
  // zlyhanie SMTP odoslania (502) a nenakonfigurovaný mailer (503) zostávajú
  // HTTP-úrovňové chyby, rovnaký vzor ako `/api/orders/ingest`.
  app.post(
    "/api/suppliers/:supplier/order-mail/send",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", supplierParam),
    async (c) => {
      if (sendMail === undefined) {
        return c.json({ error: "Odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST)." }, 503);
      }
      const { supplier } = c.req.valid("param");
      const user = c.get("user");
      const now = new Date();

      const result = await sendSupplierOrderMail(db, sendMail, supplier);
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "orders.mail.send",
        entity: "supplier_contact",
        entityId: supplier,
        data:
          result.status === "sent"
            ? { supplier, status: result.status, recipient: result.to, itemCount: result.itemCount }
            : { supplier, status: result.status },
      });
      log.info({ actorUserId: user.userId, supplier, status: result.status }, "odoslanie objednávky dodávateľovi mailom");

      switch (result.status) {
        case "sent":
          return c.json({ ok: true as const, to: result.to, itemCount: result.itemCount });
        case "no_email":
          return c.json({ ok: false as const, error: "Pre tohto dodávateľa nie je nastavený e-mail." });
        case "no_items":
          return c.json({ ok: false as const, error: "Nie sú žiadne položky na objednanie pre tohto dodávateľa." });
        case "send_failed":
          return c.json({ error: "Odoslanie e-mailu zlyhalo. Skúste to znova o chvíľu." }, 502);
      }
    },
  );
}
