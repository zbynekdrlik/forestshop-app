import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { record } from "../modules/audit/service.js";
import { EMAIL_TYPES } from "../modules/nedostupne/constants.js";
import { consumePreviewToken, issuePreviewToken } from "../modules/nedostupne/preview-tokens.js";
import { listNedostupneGroups } from "../modules/nedostupne/queries.js";
import { addReplacementLink, removeReplacementLink } from "../modules/nedostupne/replacement-links.js";
import { setVariantResolved } from "../modules/nedostupne/resolved.js";
import { buildEmailForType, findNedostupneContext, sendNedostupneEmail } from "../modules/nedostupne/send.js";
import type { MailTransport } from "../modules/mail/transport.js";
import { startsWithFormulaChar } from "../modules/shoptet-writeback/formula-guard.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

export interface NedostupneRunDeps {
  readonly mailTransport: MailTransport | undefined;
  readonly bccEmail: string | undefined;
  readonly adminBaseUrl: string;
}

const previewBody = z.object({ orderCode: z.string().min(1), variantCode: z.string().min(1), emailType: z.enum(EMAIL_TYPES) });
// issue 176 (code review pred mergom, PR #182): `/send` musí priniesť token
// vydaný `/preview` PRE PRESNE tento (orderCode, variantCode, emailType) —
// server-side vynútenie "náhľad VŽDY predchádza odoslaniu", pozri
// `preview-tokens.ts`. Bez tohto by priame volanie API (mimo React UI) mohlo
// poslať e-mail bez toho, aby čokoľvek jeho obsah niekedy zobrazilo.
// issue 277: obsluha mohla text v okne náhľadu upraviť pred odoslaním —
// voliteľné, aby priame API volanie bez úpravy (nič neposlalo v `editedBody`)
// ostalo spätne kompatibilné a poslalo pôvodné vyrenderované znenie.
const sendBody = previewBody.extend({ previewToken: z.string().min(1), editedBody: z.string().trim().min(1).max(20000).optional() });

// issue 238: majiteľov RUČNE vložený odkaz náhrady — validovaný ako URL
// (rovnaká disciplína ako `orders-routes.ts`'s `orderLineSupplierLinkBody`,
// issue 121/153): odkaz sa vykresľuje priamo ako `<a href>` v e-maile
// zákazníkovi, takže potrebuje TÚ ISTÚ obranu (http(s)-only regex + formula-
// injection `.refine`), nielen holé `.url()`.
const replacementLinkBody = z.object({
  variantCode: z.string().trim().min(1).max(200),
  url: z
    .string()
    .trim()
    .url()
    .max(2000)
    .regex(/^https?:\/\//)
    .refine((v) => !startsWithFormulaChar(v), {
      message: "odkaz nesmie začínať znakom vzorca (=, +, -, @) — možný pokus o CSV-injection",
    }),
});
const replacementLinkParam = z.object({ id: z.string().uuid() });

// issue 531: ručné označenie „vyriešené" pri karte produktu — idempotentné
// NASTAVENIE želaného stavu (nie POST/DELETE dvojica), keďže ide o boolean
// prepínač. `variantCode` je kľúč skupiny (`NedostupneGroup`).
const resolvedBody = z.object({ variantCode: z.string().trim().min(1).max(200), resolved: z.boolean() });

function bccMissing(deps: NedostupneRunDeps): boolean {
  return deps.bccEmail === undefined || deps.bccEmail.trim() === "";
}

function mailNotConfigured(deps: NedostupneRunDeps): boolean {
  return deps.mailTransport === undefined;
}

function sendErrorMessage(result: Extract<Awaited<ReturnType<typeof sendNedostupneEmail>>, { readonly ok: false }>): string {
  switch (result.code) {
    case "not_found":
      return "Riadok objednávky sa v aktuálnom zozname nenašiel — pravdepodobne sa medzitým zmenil jeho stav.";
    case "already_sent":
      return "Tento e-mail už bol tejto objednávke odoslaný.";
    case "no_email":
      return "Objednávka nemá e-mailovú adresu.";
    case "not_configured":
      return result.reason;
    case "send_failed":
      return "Odoslanie e-mailu zlyhalo — skúste to znova.";
  }
}

export function registerNedostupneRoutes(app: Hono<AppBindings>, db: Database, deps: NedostupneRunDeps): void {
  // Čítanie — každý prihlásený zamestnanec (rovnaká úroveň ako #172/#173).
  app.get("/api/nedostupne", requireUser(db), async (c) => {
    const groups = await listNedostupneGroups(db, deps.adminBaseUrl);
    return c.json({
      groups,
      bccMissing: bccMissing(deps),
      mailNotConfigured: mailNotConfigured(deps),
    });
  });

  // Povinný náhľad — POČÍTANÝ ROVNAKOU funkciou (`buildEmailForType`), akú
  // použije skutočné odoslanie nižšie, takže obsluha VŽDY vidí presne to, čo
  // sa (prípadne) odošle. `requireSameOrigin()` (code review pred mergom, PR
  // #182): teraz aj vydáva token (`issuePreviewToken`) — konzistentne s
  // KAŽDÝM iným POST v tejto appke, hoci reálne riziko je nízke (appka
  // nikde nekonfiguruje CORS, takže cudzia stránka by aj tak nevedela
  // prečítať telo odpovede a token z neho vytiahnuť).
  app.post(
    "/api/nedostupne/preview",
    requireSameOrigin(),
    requireUser(db),
    zValidator("json", previewBody),
    async (c) => {
      const { orderCode, variantCode, emailType } = c.req.valid("json");
      const ctx = await findNedostupneContext(db, orderCode, variantCode);
      if (ctx === null) {
        // 200 (nikdy 404) — rovnaká disciplína ako #172/#173's preview
        // (`.claude/rules/testing.md`'s Chromium console-error pravidlo).
        return c.json({ ok: false as const, error: "Riadok objednávky sa v aktuálnom zozname nenašiel." });
      }
      const built = await buildEmailForType(db, ctx, emailType);
      const previewToken = issuePreviewToken(orderCode, variantCode, emailType, new Date());
      // issue 277: `text` je plain-textová verzia (rovnaká, akú appka odošle
      // ako fallback) — frontend ju predvyplní do editovateľného okna.
      return c.json({ ok: true as const, subject: built.subject, html: built.html, text: built.text, recipient: ctx.email, customerName: ctx.customerName, previewToken });
    },
  );

  // Odoslanie — mutuje (dedup zápis), rovnaká rola ako #172/#173.
  app.post(
    "/api/nedostupne/send",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", sendBody),
    async (c) => {
      const { orderCode, variantCode, emailType, previewToken, editedBody } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      // Server-side vynútenie povinného náhľadu (code review pred mergom,
      // PR #182) — token sa KONZUMUJE (zmaže) hneď, bez ohľadu na výsledok,
      // takže jeden náhľad = najviac jeden pokus o odoslanie.
      if (!consumePreviewToken(previewToken, orderCode, variantCode, emailType, now)) {
        return c.json({ ok: false as const, error: "Najprv si otvorte náhľad e-mailu — bez neho appka nepošle nič." });
      }
      const result = await sendNedostupneEmail({
        db,
        now,
        orderCode,
        variantCode,
        emailType,
        mailTransport: deps.mailTransport,
        bccEmail: deps.bccEmail,
        // issue 193: kniha odoslaných e-mailov ukáže, KTO odoslanie spustil.
        actorUserId: user.userId,
        ...(editedBody === undefined ? {} : { editedBody }),
      });
      if (!result.ok) {
        return c.json({ ok: false as const, error: sendErrorMessage(result) });
      }
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "nedostupne.send",
        entity: "nedostupne_state",
        entityId: `${orderCode}|${variantCode}|${emailType}`,
        data: { orderCode, variantCode, emailType },
      });
      return c.json({ ok: true as const });
    },
  );

  // issue 238: majiteľ pridá ručný odkaz náhrady — rovnaké oprávnenie ako
  // `/send` (admin/manazer, `.claude/rules/nedostupne.md`'s dizajnový
  // komentár), rovnaký jednoduchý insert+audit vzor ako
  // `orders/supplier-link-assignment.ts`'s `setProductSupplierLink`.
  app.post(
    "/api/nedostupne/replacement-links",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", replacementLinkBody),
    async (c) => {
      const { variantCode, url } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      const link = await addReplacementLink(db, variantCode, url, now);
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "nedostupne.replacement_link.added",
        entity: "nedostupne_replacement_link",
        entityId: link.id,
        data: { variantCode, url },
      });
      return c.json({ ok: true as const, link });
    },
  );

  // Zmazanie — rovnaké oprávnenie. `id` neznáme/už zmazané je NEŠKODNÉ
  // (rovnaká disciplína ako `.claude/rules/testing.md`'s "bežné, OČAKÁVANÉ
  // zlyhanie vracia 200 {ok:false}", nikdy 4xx) — dvojklik na "zmazať" je
  // bežná používateľská udalosť, nie chyba.
  app.delete(
    "/api/nedostupne/replacement-links/:id",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("param", replacementLinkParam),
    async (c) => {
      const { id } = c.req.valid("param");
      const user = c.get("user");
      const removed = await removeReplacementLink(db, id);
      if (removed) {
        await record(db, {
          at: new Date(),
          actorUserId: user.userId,
          action: "nedostupne.replacement_link.removed",
          entity: "nedostupne_replacement_link",
          entityId: id,
          data: { id },
        });
      }
      return c.json({ ok: true as const, removed });
    },
  );

  // issue 531: prepnutie „vyriešené" pri karte produktu — rovnaké oprávnenie
  // ako ostatné zápisy na tejto obrazovke (admin/manazer, parita s poznámkou/
  // odkazmi náhrad). Idempotentné nastavenie na želaný stav; „nič ďalšie sa
  // nestane, len sa to označí" — žiadny vedľajší efekt (žiadny e-mail, žiadne
  // filtrovanie), len persistovaný zobrazovací príznak.
  app.put(
    "/api/nedostupne/resolved",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", resolvedBody),
    async (c) => {
      const { variantCode, resolved } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      await setVariantResolved(db, variantCode, resolved, now);
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: resolved ? "nedostupne.resolved.marked" : "nedostupne.resolved.cleared",
        entity: "nedostupne_resolved",
        entityId: variantCode,
        data: { variantCode, resolved },
      });
      return c.json({ ok: true as const, resolved });
    },
  );
}
