import type { Database } from "../../db/client.js";
import { log } from "../../logger.js";
import { zonedDateKey } from "../../timezone.js";
import type { MailTransport } from "../mail/transport.js";
import { recordSkippedMail, sendLoggedMail, type MailLogContext } from "../mail-log/service.js";
import { buildShoptetAdminOrderUrl } from "../orders/queries.js";
import { pluralWord } from "../orders/pluralize.js";
import { resolveTemplate } from "../mail-templates/store.js";
import { autoResolveByDedupKey, updateIfUnresolvedByDedupKey, upsertUpozornenie } from "../upozornenia/service.js";
import {
  buildEmail,
  classifyTracking,
  postaTemplateKey,
  postaUpozornenieDedupKey,
  shouldSend,
  sourceCoverage,
  terminalState,
  type SourceCoverage,
} from "./logic.js";
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
  // issue 193: kto beh vyvolal — plánovač, alebo zamestnanec cez "Spustiť
  // teraz". Zapisuje sa do knihy odoslaných e-mailov, nikdy sa neodvodzuje z
  // toho, či je `actorUserId` vyplnené. Predvolene `scheduled`, aby existujúci
  // volajúci (job) nemusel nič meniť.
  readonly trigger?: "scheduled" | "manual";
  readonly actorUserId?: string;
}

// Ďalší voľný kľúč v registri `.claude/rules/scheduler.md` (787_878_001/002/
// 003/100 sú obsadené) — review na PR 177 upozornila, že manuálne "Spustiť
// teraz" (HTTP) a naplánovaný denný beh majú PRESNE rovnaký tvar súbehu ako
// `catalogImportJob`/`ordersImportJob` (ktoré preto majú svoj VLASTNÝ
// advisory zámok vnútri `ingestCatalog`/`ingestOrders`), ale tento modul ho
// pôvodne nemal vôbec: dva prekrývajúce sa behy (dvaja manažéri klikli
// "Spustiť teraz" súčasne, alebo ručný klik sa prekryl s 07:00 UTC
// naplánovaným behom) by mohli OBA prečítať ten istý predošlý `notifyCount`/
// `lastSentAt` PRED tým, než ktorýkoľvek zapíše — a OBA by tak mohli poslať
// ten istý eskalačný e-mail zákazníkovi duplicitne, presne to, čomu má
// 4-emailová kadencia zabrániť. `pg_advisory_lock` (SESSION-scoped, nie
// `pg_advisory_xact_lock` v transakcii) beží na VLASTNOM vyhradenom
// pripojení z poolu (rovnaký vzor ako `tests/helpers/db.ts`'s
// `withCleanDb()`) — nie transakcia okolo celého behu, lebo beh robí desiatky
// sekvenčných sieťových volaní na posta.sk a držať jednu DB transakciu otvorenú
// počas nich by zbytočne zaťažovalo connection pool.
export const POSTA_UNCOLLECTED_RUN_LOCK_KEY = 787_878_004;

/** Core beh (jedno vyhodnotenie): eligible objednávky → tracking na
 * poste.sk → eskalačné e-maily → nový stav → coverage poistka. Volá sa PRIAMO
 * z HTTP "Spustiť teraz" (vždy, bez ohľadu na `enabled`) aj z naplánovaného
 * jobu (`scheduler/jobs.ts`'s `postaUncollectedJob`, ktorý PRED volaním
 * kontroluje `enabled` — pozri návrhový komentár na issue 172, "Spustiť
 * teraz" je explicitná ľudská akcia presne ako stará appka's `run_now`).
 * Serializovaný `POSTA_UNCOLLECTED_RUN_LOCK_KEY`-om — druhý súbežný beh
 * (iný manažér, alebo prekryv s naplánovaným behom) počká, kým prvý celý
 * doskončí, namiesto toho, aby mohol poslať duplicitný e-mail. */
export async function runPostaUncollected(options: RunPostaUncollectedOptions): Promise<PostaUncollectedRunResult> {
  const { db } = options;
  const lockClient = await db.$client.connect();
  try {
    await lockClient.query("select pg_advisory_lock($1)", [POSTA_UNCOLLECTED_RUN_LOCK_KEY]);
    return await runPostaUncollectedLocked(options);
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [POSTA_UNCOLLECTED_RUN_LOCK_KEY]);
    lockClient.release();
  }
}

async function runPostaUncollectedLocked(options: RunPostaUncollectedOptions): Promise<PostaUncollectedRunResult> {
  const { db, now, trackingClient, mailTransport, bccEmail, adminBaseUrl, actorUserId } = options;
  const trigger = options.trigger ?? "scheduled";
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
      // issue 268: zásielka je doručená/vrátená — karta na Upozorneniach (ak
      // vôbec vznikla) sa ZATVÁRA SAMA, bez zásahu majiteľa. Bezpečný no-op,
      // keď žiadna nevyriešená karta pre tento dedupKey neexistuje.
      await autoResolveByDedupKey(db, postaUpozornenieDedupKey(packageNumber), now);
      continue;
    }

    const cls = classifyTracking(trackingJson, now);
    if (cls.status === "invalid_format") {
      // issue 275 (medzera nájdená code review-om na #268): zásielka, ktorá
      // UŽ MÁ nevyriešenú kartu na Upozorneniach (vznikla skôr, kým bola v
      // stave notified/ZNP), a ktorej tracking neskôr začne vracať
      // nečitateľný formát — karta sa OZNAČÍ inak (aby majiteľ vedel, PREČO
      // sa sama nezavrie), ale NIKDY sa automaticky nezavrie (to by skrylo
      // reálny, ešte nevyriešený problém) a NIKDY sa nevyrobí NOVÁ (zásielka,
      // čo nikdy predtým nebola nahlásená, nepotrebuje kartu len kvôli
      // jednorazovému/prechodnému zlyhaniu sledovania) —
      // `updateIfUnresolvedByDedupKey` je čisto UPDATE-if-exists.
      await updateIfUnresolvedByDedupKey(db, postaUpozornenieDedupKey(packageNumber), {
        title: `Zásielka pre objednávku ${shipment.externalOrderId} — sledovanie zlyhalo (over ručne)`,
        details: [
          `Zákazník: ${shipment.customerName}`,
          `Číslo zásielky: ${packageNumber}`,
          "Sledovanie na Pošte SK vrátilo nečitateľný formát — appka už nevie automaticky rozoznať, či je zásielka vyzdvihnutá.",
          "Over stav ručne (posta.sk alebo Shoptet) a kartu vybav manuálne.",
        ].join("\n"),
      });
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
      // issue 193: kontext pre spoločnú knihu odoslaných e-mailov — `sequence`
      // nesie poradie upozornenia (1–4), takže z prehľadu vidno eskaláciu,
      // nie zdanlivé opakovanie toho istého e-mailu.
      const logCtx: MailLogContext = {
        source: "posta_uncollected",
        trigger,
        templateKey: postaTemplateKey(nextCount),
        orderCode: shipment.externalOrderId,
        packageNumber,
        sequence: nextCount,
        ...(actorUserId === undefined ? {} : { actorUserId }),
      };
      if (bccMissing || mailNotConfigured || recipient === "") {
        emailsBlocked += 1;
        const reason =
          recipient === ""
            ? "objednávka nemá e-mailovú adresu zákazníka"
            : bccMissing
              ? "chýba adresa pre skrytú kópiu majiteľovi (POSTA_UNCOLLECTED_BCC_EMAIL)"
              : "odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST)";
        await recordSkippedMail(db, now, logCtx, recipient, reason);
        if (recipient === "" && !bccMissing && !mailNotConfigured) {
          log.error(
            { orderCode: shipment.externalOrderId, packageNumber },
            "nevyzdvihnutá zásielka nemá e-mail zákazníka — upozornenie sa nedá poslať",
          );
        }
      } else {
        const built = buildEmail(
          await resolveTemplate(db, postaTemplateKey(nextCount)),
          shipment.customerName,
          packageNumber,
          cls.officeName,
          cls.officeAddr,
          cls.retainedTill,
          now,
        );
        // BCC je pre TENTO mail ZÁVÄZNÁ (ticket's jediná bezpečnostná
        // podmienka) — `bccMissing` vyššie to už vylúčilo, `bccEmail` je tu
        // vždy definovaný neprázdny reťazec. issue 193: odoslanie ide cez
        // `sendLoggedMail`, ktorý si sám zapíše výsledok (odoslané/zlyhalo)
        // do knihy odoslaných e-mailov; zlyhanie sa NEVYHADZUJE, vracia sa
        // ako `ok: false` — zásielka preto ostáva v zozname nevyzdvihnutých
        // s PÔVODNÝM počítadlom, presne ako pred touto zmenou.
        const sendResult = await sendLoggedMail(
          db,
          mailTransport,
          { to: recipient, subject: built.subject, text: built.text, html: built.html, bcc: bccEmail },
          now,
          logCtx,
        );
        if (sendResult.ok) {
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
        } else {
          log.error(
            { orderCode: shipment.externalOrderId, packageNumber, rawErrorMessage: sendResult.rawErrorMessage },
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
      // issue 268: JEDINÁ zapisovacia cesta (#267/#272) — opakovaný denný
      // beh na TÚ ISTÚ zásielku len OBNOVÍ existujúcu kartu (rovnaký
      // `dedupKey`), nikdy nevyrobí druhú.
      const daysWord = pluralWord(cls.daysAtPost, "deň", "dni", "dní");
      await upsertUpozornenie(db, {
        type: "nevyzdvihnuta_zasielka",
        source: "appka",
        title: `Zásielka pre objednávku ${shipment.externalOrderId} sa nevyzdvihla — ${String(cls.daysAtPost)} ${daysWord} na pošte`,
        details: [
          `Zákazník: ${shipment.customerName}`,
          `Číslo zásielky: ${packageNumber}`,
          `Dopravca: ${shipment.shippingCarrierName ?? ""}`,
          `Čaká: ${String(cls.daysAtPost)} ${daysWord} na pošte`,
        ].join("\n"),
        link: adminOrderUrl(shipment),
        dedupKey: postaUpozornenieDedupKey(packageNumber),
        now,
      });
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
        // issue 293: SLOVENSKÝ deň behu, nie UTC — rovnaký dôvod ako
        // `state.ts`'s `upsertPostaUncollectedState`.
        lastSentAt: effectiveLastSent === null ? "" : zonedDateKey(effectiveLastSent),
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
