import { and, eq, inArray } from "drizzle-orm";
import { upozornenie } from "../../db/schema.js";
import { buildShoptetAdminOrderUrl } from "./queries.js";
import { classifyFinishedReturnStatus, classifyReturnStatus, returnUpozornenieDedupKey } from "./return-status.js";
import { autoResolveByDedupKey, upsertUpozornenie, type UpozornenieExecutor } from "../upozornenia/service.js";

// Malá, zámerne DUPLIKOVANÁ kópia `ingest.ts`'s `chunk()` — import odtiaľ by
// vyrobil CYKLICKÚ závislosť (`ingest.ts` volá TENTO súbor). Rovnaká
// disciplína ako `upozornenia/service.ts`'s `isUniqueViolation`
// (`.claude/rules/mvp-philosophy.md`: žiadna zdieľaná abstrakcia pre dvoch
// konzumentov v nesúvisiacich moduloch, keď je priama kópia rovnako čitateľná).
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// issue 269/297: druhý automatický zdroj pre nástenku Upozornenia (#267) —
// objednávka, ktorej `statusName` je AKTÍVNY vrátkový stav (`return-status.ts`),
// dostane/obnoví kartu cez ZDIEĽANÚ zapisovaciu cestu (`upsertUpozornenie`,
// #267/#272); objednávka, ktorej `statusName` je HOTOVÝ vrátkový stav (#297,
// "Vybavená výmena"/"Vybavený Dobropis"), namiesto toho AUTOMATICKY ZATVORÍ
// svoju existujúcu otvorenú kartu (`autoResolveByDedupKey`, rovnaký princíp
// ako #268's doručená zásielka). `dedupKey` je na OBJEDNÁVKU (nie na
// pod-stav) — opakovaný import v tom istom AKTÍVNOM stave, alebo prechod
// medzi dvomi objednávkami rovnakého kandidáta, len OBNOVÍ tú istú kartu.
// Vyčlenené z `ingest.ts` do VLASTNÉHO súboru (issue 297 poslalo `ingest.ts`
// cez eslint `max-lines: 400`, `.claude/rules/testing.md`) — volá sa ZÁMERNE
// AŽ TESNE PRED COMMITOM tej istej transakcie (viď volajúce miesto), nie
// hneď po upsert-e `order` riadkov: `.for("update")` pre-check nižšie drží
// riadkové zámky na EXISTUJÚCICH kartách po ZVYŠOK transakcie, takže čím
// neskôr beží, tým kratšie sú zámky držané — inak by majiteľov klik
// "Vybavené" čakal, kým dobehne CELÝ zvyšok importu.
export interface ApplyReturnUpozorneniaOptions {
  readonly tx: UpozornenieExecutor;
  readonly orderInfo: ReadonlyMap<string, { readonly customerName: string; readonly statusName: string }>;
  readonly orderIdsByCode: ReadonlyMap<string, number>;
  readonly adminBaseUrl: string;
  readonly now: Date;
  // `ingest.ts`'s `ORDERS_INGEST_BATCH_SIZE` — posielaný explicitne (nie
  // importovaný priamo odtiaľ), aby sa predišlo cyklickej závislosti.
  readonly batchSize: number;
}

export interface ApplyReturnUpozorneniaResult {
  readonly skippedResolvedReturnCount: number;
  readonly autoResolvedFinishedReturnCount: number;
}

export async function applyReturnUpozornenia(options: ApplyReturnUpozorneniaOptions): Promise<ApplyReturnUpozorneniaResult> {
  const { tx, orderInfo, orderIdsByCode, adminBaseUrl, now, batchSize } = options;
  const returnCandidates: { externalOrderId: string; returnLabel: string; customerName: string; statusName: string; dedupKey: string }[] = [];
  // Objednávky, ktorých stav je HOTOVÝ, NIKDY nejdú do `returnCandidates`
  // (žiadna nová/obnovená karta) — ich `dedupKey` ide do TEJTO množiny, ktorá
  // po dávke ZATVORÍ existujúcu otvorenú kartu (ak vôbec vznikla).
  const finishedReturnDedupKeys: string[] = [];
  for (const [externalOrderId, info] of orderInfo) {
    const returnLabel = classifyReturnStatus(info.statusName);
    if (returnLabel !== null) {
      returnCandidates.push({ externalOrderId, returnLabel, customerName: info.customerName, statusName: info.statusName, dedupKey: returnUpozornenieDedupKey(externalOrderId) });
      continue;
    }
    if (classifyFinishedReturnStatus(info.statusName) !== null) finishedReturnDedupKeys.push(returnUpozornenieDedupKey(externalOrderId));
  }

  // Naživo overené na produkcii (0.3.0-dev.160): vybavené vrátenie je
  // KONEČNÉ — na rozdiel od #268 (zásielka, čo sa smie znova zaseknúť o
  // mesiac) sa už NIKDY nemá znova ohlásiť, hoci Shoptet-ov status objednávky
  // ostáva v tom istom AKTÍVNOM stave navždy. `upsertUpozornenie`'s
  // ČIASTOČNÝ unique index (`WHERE resolved_at IS NULL`, `.claude/rules/
  // upozornenia.md`) necháva VYRIEŠENÝ riadok mimo arbitra, takže bez tejto
  // kontroly by ďalší import s tým istým `dedupKey` prešiel ako čistý INSERT.
  //
  // Skip sa smie uplatniť LEN keď pre `dedupKey` NEEXISTUJE žiadny
  // NEVYRIEŠENÝ súrodenec (kľúč môže mať SÚČASNE vyriešený aj otvorený riadok
  // — historický bug na 0.3.0-dev.160) — inak by ten otvorený navždy zamrzol.
  // `.for("update")` je POVINNÉ (nie voliteľné) — bez neho by súbežné ručné
  // "Vybavené" (`resolveUpozornenie`, mimo tejto transakcie) mohlo commitnúť
  // PRESNE medzi pre-checkom a neskorším `upsertUpozornenie` volaním pre TEN
  // ISTÝ kandidát, a ten istý bug (len naživo zriedkavejší) by sa zopakoval.
  const resolvedReturnDedupKeys = new Set<string>();
  if (returnCandidates.length > 0) {
    for (const batch of chunk(returnCandidates.map((c) => c.dedupKey), batchSize)) {
      const candidateRows = await tx
        .select({ dedupKey: upozornenie.dedupKey, resolvedAt: upozornenie.resolvedAt })
        .from(upozornenie)
        .where(and(eq(upozornenie.type, "vratenie"), inArray(upozornenie.dedupKey, batch)))
        .for("update");
      // `row.dedupKey` je nullable v type, ale `inArray` NIKDY nezhodí NULL
      // (Postgres `IN` sémantika) — `continue` nižšie je len TS-narrowing.
      const hasUnresolvedByKey = new Map<string, boolean>();
      for (const row of candidateRows) {
        const dedupKey = row.dedupKey;
        if (dedupKey === null) continue;
        const already = hasUnresolvedByKey.get(dedupKey) ?? false;
        hasUnresolvedByKey.set(dedupKey, already || row.resolvedAt === null);
      }
      for (const [dedupKey, hasUnresolved] of hasUnresolvedByKey) {
        if (!hasUnresolved) resolvedReturnDedupKeys.add(dedupKey);
      }
    }
  }
  let skippedResolvedReturnCount = 0;
  for (const candidate of returnCandidates) {
    if (resolvedReturnDedupKeys.has(candidate.dedupKey)) {
      skippedResolvedReturnCount += 1;
      continue;
    }
    await upsertUpozornenie(tx, {
      type: "vratenie",
      source: "appka",
      title: `Objednávka ${candidate.externalOrderId} — ${candidate.returnLabel}`,
      details: [`Zákazník: ${candidate.customerName}`, `Stav objednávky: ${candidate.statusName}`].join("\n"),
      link: buildShoptetAdminOrderUrl(adminBaseUrl, candidate.externalOrderId, orderIdsByCode.get(candidate.externalOrderId) ?? null),
      dedupKey: candidate.dedupKey,
      now,
    });
  }

  // issue 297: objednávka, ktorá prešla do HOTOVÉHO vrátkového stavu, ZATVÁRA
  // svoju existujúcu otvorenú kartu SAMA (`resolvedByUserId` ostáva `null`,
  // "vybavené systémom"). Jednoduchý UPDATE bez TOCTOU rizika (na rozdiel od
  // `upsertUpozornenie`'s INSERT vyššie) — súbežné dvojité zatvorenie je
  // idempotentné, druhé volanie jednoducho nenájde žiadny riadok na
  // aktualizáciu. Bezpečný no-op, keď pre `dedupKey` žiadna nevyriešená karta
  // neexistuje (objednávka bola HOTOVÁ už pri PRVOM importe).
  let autoResolvedFinishedReturnCount = 0;
  for (const dedupKey of finishedReturnDedupKeys) {
    if (await autoResolveByDedupKey(tx, dedupKey, now)) autoResolvedFinishedReturnCount += 1;
  }

  return { skippedResolvedReturnCount, autoResolvedFinishedReturnCount };
}
