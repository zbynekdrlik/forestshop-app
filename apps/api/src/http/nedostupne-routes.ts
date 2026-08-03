import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { record } from "../modules/audit/service.js";
import { EMAIL_TYPES } from "../modules/nedostupne/constants.js";
import { consumePreviewToken, issuePreviewToken } from "../modules/nedostupne/preview-tokens.js";
import { listNedostupneGroups } from "../modules/nedostupne/queries.js";
import { buildEmailForType, findNedostupneContext, sendNedostupneEmail } from "../modules/nedostupne/send.js";
import type { MailTransport } from "../modules/mail/transport.js";
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
const sendBody = previewBody.extend({ previewToken: z.string().min(1) });

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
      return c.json({ ok: true as const, subject: built.subject, html: built.html, recipient: ctx.email, customerName: ctx.customerName, previewToken });
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
      const { orderCode, variantCode, emailType, previewToken } = c.req.valid("json");
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
}
