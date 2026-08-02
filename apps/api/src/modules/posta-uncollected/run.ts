import type { Database } from "../../db/client.js";
import { log } from "../../logger.js";
import type { MailTransport } from "../mail/transport.js";
import { buildShoptetAdminOrderUrl } from "../orders/queries.js";
import { buildEmail, classifyTracking, shouldSend, sourceCoverage, terminalState, type SourceCoverage } from "./logic.js";
import { loadEligibleOrders } from "./orders-source.js";
import { loadPostaUncollectedState, prunePostaUncollectedState, upsertPostaUncollectedState } from "./state.js";
import { TERMINAL_CACHE_DAYS, trackingLink } from "./constants.js";
import type { TrackingClient } from "./tracking-client.js";

export interface PostaUncollectedShipmentRow {
  readonly orderCode: string;
  readonly packageNumber: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly officeName: string;
  readonly officeAddr: string;
  readonly retainedTill: string;
  readonly notifiedSince: string;
  readonly daysAtPost: number;
  readonly count: number;
  readonly lastSentAt: string;
  readonly callNeeded: boolean;
  readonly trackingLink: string;
  readonly adminLink: string;
}

export interface PostaUncollectedInvalidRow {
  readonly orderCode: string;
  readonly packageNumber: string;
  readonly name: string;
  readonly adminLink: string;
}

export interface PostaUncollectedErrorRow {
  readonly orderCode: string;
  readonly packageNumber: string;
  readonly message: string;
}

export interface PostaUncollectedRunResult {
  readonly checkedAt: string;
  readonly uncollected: readonly PostaUncollectedShipmentRow[];
  readonly invalid: readonly PostaUncollectedInvalidRow[];
  readonly errors: readonly PostaUncollectedErrorRow[];
  readonly coverage: SourceCoverage;
  readonly bccMissing: boolean;
  readonly mailNotConfigured: boolean;
  readonly stats: {
    readonly checked: number;
    readonly uncollectedCount: number;
    readonly invalidCount: number;
    readonly errorCount: number;
    readonly apiSkipped: number;
    readonly emailsSent: number;
    readonly emailsBlocked: number;
  };
}

export interface RunPostaUncollectedOptions {
  readonly db: Database;
  readonly now: Date;
  readonly trackingClient: TrackingClient;
  readonly mailTransport: MailTransport | undefined;
  readonly bccEmail: string | undefined;
  readonly adminBaseUrl: string;
}

/** Core beh (jedno vyhodnotenie): eligible objednávky → tracking na
 * poste.sk → eskalačné e-maily → nový stav → coverage poistka. Volá sa PRIAMO
 * z HTTP "Spustiť teraz" (vždy, bez ohľadu na `enabled`) aj z naplánovaného
 * jobu (`scheduler/jobs.ts`'s `postaUncollectedJob`, ktorý PRED volaním
 * kontroluje `enabled` — pozri návrhový komentár na issue 172, "Spustiť
 * teraz" je explicitná ľudská akcia presne ako stará appka's `run_now`). */
export async function runPostaUncollected(options: RunPostaUncollectedOptions): Promise<PostaUncollectedRunResult> {
  const { db, now, trackingClient, mailTransport, bccEmail, adminBaseUrl } = options;
  const adminOrderUrl = (order: { readonly externalOrderId: string; readonly shoptetOrderId: number | null }): string =>
    buildShoptetAdminOrderUrl(adminBaseUrl, order.externalOrderId, order.shoptetOrderId);

  const eligible = await loadEligibleOrders(db, now);
  const coverage = sourceCoverage(eligible, now);
  const shipments = eligible.filter((o) => (o.packageNumber ?? "") !== "");
  const orderCodes = shipments.map((s) => s.externalOrderId);
  const stateMap = await loadPostaUncollectedState(db, orderCodes);

  const uncollected: PostaUncollectedShipmentRow[] = [];
  const invalid: PostaUncollectedInvalidRow[] = [];
  const errors: PostaUncollectedErrorRow[] = [];
  let apiSkipped = 0;
  let emailsSent = 0;
  let emailsBlocked = 0;
  const bccMissing = bccEmail === undefined || bccEmail.trim() === "";
  const mailNotConfigured = mailTransport === undefined;

  for (const shipment of shipments) {
    const packageNumber = shipment.packageNumber ?? "";
    const existing = stateMap.get(shipment.externalOrderId);

    // #222 (stará appka) — už raz zistený TERMINÁLNY stav (doručené/prevzaté)
    // sa `TERMINAL_CACHE_DAYS` dní nepýta znova. Bezpečnostná hranica: keby
    // sa číslo zásielky na objednávke medzičasom ručne PRETYPOVALO, cache
    // sa síce chvíľu nesprávne drží starého záveru, ale sama vyprší najviac
    // za `TERMINAL_CACHE_DAYS` dní — nikdy nezostane zaseknutá naveky.
    if (existing?.terminalState !== null && existing?.terminalState !== undefined && existing.terminalAt !== null) {
      const ageDays = Math.floor((now.getTime() - existing.terminalAt.getTime()) / 86_400_000);
      if (ageDays < TERMINAL_CACHE_DAYS) {
        apiSkipped += 1;
        continue;
      }
    }

    const trackingJson = await trackingClient(packageNumber);
    if (trackingJson === null) {
      errors.push({
        orderCode: shipment.externalOrderId,
        packageNumber,
        message: "Overenie stavu na Pošte SK zlyhalo (výpadok/timeout) — skúsi sa znova nabudúce.",
      });
      continue;
    }

    const final = terminalState(trackingJson);
    if (final !== "") {
      await upsertPostaUncollectedState(
        db,
        {
          orderCode: shipment.externalOrderId,
          notifyCount: existing?.notifyCount ?? 0,
          lastSentAt: existing?.lastSentAt ?? null,
          terminalState: final,
          terminalAt: now,
        },
        now,
      );
      continue;
    }

    const cls = classifyTracking(trackingJson, now);
    if (cls.status === "invalid_format") {
      invalid.push({
        orderCode: shipment.externalOrderId,
        packageNumber,
        name: shipment.customerName,
        adminLink: adminOrderUrl(shipment),
      });
      continue;
    }

    const priorCount = existing?.notifyCount ?? 0;
    const priorLastSent = existing?.lastSentAt ?? null;
    const wantsSend = cls.uncollected && shouldSend(priorCount, priorLastSent, now);

    let effectiveCount = priorCount;
    let effectiveLastSent = priorLastSent;
    if (wantsSend) {
      const nextCount = priorCount + 1;
      const recipient = (shipment.email ?? "").trim();
      if (bccMissing || mailNotConfigured || recipient === "") {
        emailsBlocked += 1;
        if (recipient === "" && !bccMissing && !mailNotConfigured) {
          log.error(
            { orderCode: shipment.externalOrderId, packageNumber },
            "nevyzdvihnutá zásielka nemá e-mail zákazníka — upozornenie sa nedá poslať",
          );
        }
      } else {
        const built = buildEmail(nextCount, shipment.customerName, packageNumber, cls.officeName, cls.officeAddr, cls.retainedTill, now);
        try {
          // BCC je pre TENTO mail ZÁVÄZNÁ (ticket's jediná bezpečnostná
          // podmienka) — `bccMissing` vyššie to už vylúčilo, `bccEmail` je
          // tu vždy definovaný neprázdny reťazec.
          await mailTransport({
            to: recipient,
            subject: built.subject,
            text: built.text,
            html: built.html,
            bcc: bccEmail,
          });
          effectiveCount = nextCount;
          effectiveLastSent = now;
          emailsSent += 1;
          // Zápis IHNEĎ po odoslaní (nie na konci celého behu) — pád appky
          // neskôr v behu nesmie stratiť dôkaz o už odoslanom e-maile
          // (rovnaká disciplína ako stará appka).
          await upsertPostaUncollectedState(
            db,
            {
              orderCode: shipment.externalOrderId,
              notifyCount: effectiveCount,
              lastSentAt: effectiveLastSent,
              terminalState: null,
              terminalAt: null,
            },
            now,
          );
        } catch (error) {
          const rawErrorMessage = error instanceof Error ? error.message : String(error);
          log.error(
            { orderCode: shipment.externalOrderId, packageNumber, rawErrorMessage },
            "odoslanie e-mailu (Nevyzdvihnuté zásielky) zlyhalo — skúsi sa znova nabudúce",
          );
        }
      }
    } else if (existing?.terminalState !== null && existing?.terminalState !== undefined) {
      // Predtým cachovaný terminálny stav, teraz opätovne overený a NIE je
      // finálny — zahodiť ho, nenechať zavádzajúci "doručené" zápis ležať
      // (rovnaký zámer ako stará appka).
      await upsertPostaUncollectedState(
        db,
        { orderCode: shipment.externalOrderId, notifyCount: priorCount, lastSentAt: priorLastSent, terminalState: null, terminalAt: null },
        now,
      );
    }

    if (cls.uncollected) {
      uncollected.push({
        orderCode: shipment.externalOrderId,
        packageNumber,
        name: shipment.customerName,
        email: shipment.email ?? "",
        phone: shipment.phone ?? "",
        officeName: cls.officeName,
        officeAddr: cls.officeAddr,
        retainedTill: cls.retainedTill,
        notifiedSince: cls.notifiedSince,
        daysAtPost: cls.daysAtPost,
        count: effectiveCount,
        lastSentAt: effectiveLastSent === null ? "" : effectiveLastSent.toISOString().slice(0, 10),
        callNeeded: effectiveCount >= 4,
        trackingLink: trackingLink(packageNumber),
        adminLink: adminOrderUrl(shipment),
      });
    }
  }

  const prunedCount = await prunePostaUncollectedState(db, orderCodes);
  if (prunedCount > 0) {
    log.info({ prunedCount }, "Nevyzdvihnuté zásielky: vyčistené záznamy mimo 30-dňové okno");
  }

  if (coverage.dispatchedStatusUnknown) {
    log.error({ coverage }, "Nevyzdvihnuté zásielky: nerozpoznané stavy objednávok — poistka proti oslepnutiu");
  }
  if (coverage.degraded) {
    log.error({ coverage }, "Nevyzdvihnuté zásielky: zdroj zásielok je DEGRADOVANÝ (chýbajúce čísla zásielok)");
  }

  return {
    checkedAt: now.toISOString(),
    uncollected,
    invalid,
    errors,
    coverage,
    bccMissing,
    mailNotConfigured,
    stats: {
      checked: shipments.length,
      uncollectedCount: uncollected.length,
      invalidCount: invalid.length,
      errorCount: errors.length,
      apiSkipped,
      emailsSent,
      emailsBlocked,
    },
  };
}
