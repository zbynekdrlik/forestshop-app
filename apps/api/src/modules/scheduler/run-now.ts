import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { jobRuns } from "../../db/schema.js";
import { log } from "../../logger.js";
import { getZonedDateParts } from "../../timezone.js";
import { getLatestJobRun } from "./queries.js";

/**
 * Zdieľaný "Spustiť teraz" (run-now) mechanizmus pre AKÚKOĽVEK automatizáciu s
 * `job_run`-based stavom (issue 413). PRED touto zmenou mala každá zo šiestich
 * automatizácií (shop-sitemap/pairing-search/posta-uncollected/order-reminder/
 * supplier-stock/restock) VLASTNÚ takmer identickú kópiu `runAndRecord` v
 * `http/*-routes.ts`, ktorá SYNCHRÓNNE `await`-ovala CELÝ beh predtým, než
 * HTTP odpoveď odišla. Cloudflare tunel má ~100s proxy timeout
 * (`.claude/rules/deploy.md`) — beh dlhší než to (supplier-stock ~72 min,
 * pairing-search ~21 min) dostal klientsky HTTP 524 a klient/proxy POŽIADAVKU
 * ZOPAKOVAL, hoci appka beh na pozadí dokončila normálne. Druhý pokus predtým
 * ČAKAL (blokujúci `pg_advisory_lock` vnútri `runXxx()`) na uvoľnenie zámku
 * prvým behom a POTOM spustil DRUHÝ, úplne zbytočný beh (naživo pozorované na
 * shop-sitemap, issue 402 — beh 13. 8. 2026 o 08:55 aj 09:01).
 *
 * `startRunNow` rieši oba nálezy z issue 413 naraz:
 *
 * 1. `pg_try_advisory_lock` (NEBLOKUJÚCI) na `job.lockKey` — keď zámok už
 *    niekto drží, HNEĎ vráti `{status:"busy"}` BEZ vloženia ďalšieho
 *    `job_run` riadku a BEZ volania `job.run()` vôbec (HTTP vrstva to premení
 *    na 409). Žiadne čakanie, žiadny druhý beh po dobehnutí prvého.
 * 2. Keď zámok získa, DRŽÍ HO PO CELÝ ČAS BEHU (na tom istom pripojení, cez
 *    ktoré ho získal) — vloží "running" `job_run` riadok, HNEĎ vráti
 *    `{status:"started"}` (HTTP vrstva 202) a `job.run(now)` spustí BEZ
 *    `await`-u v HTTP handleri (fire-and-forget); jeho výsledok/chyba sa
 *    zapíše do TOHO ISTÉHO `job_run` riadku, keď dobehne, a zámok sa uvoľní
 *    AŽ VTEDY.
 *
 * `job.run` MUSÍ byť "odomknutý" jadrový variant business funkcie (napr.
 * `runPostaUncollectedLocked`, nie `runPostaUncollected`) — inak by si beh
 * vnútri seba skúsil vziať TEN ISTÝ zámok znova (na inom pripojení) a
 * navždy by čakal na `startRunNow`, ktoré ho už drží (deadlock). Každý zo
 * šiestich modulov MÁ tento "Locked" variant interne od začiatku (`runXxx()`
 * ho volá PO získaní zámku) — stačí ho `export`-núť, žiadna zmena
 * správania. NAPLÁNOVANÝ beh (`scheduler/jobs.ts` cez `index.ts`) POUŽÍVA
 * NEZMENENÝ pôvodný `runXxx()` export (vlastný zámok dnu, presne ako
 * doteraz) — scheduler↔run-now serializácia (druhý sa ČAKAJÚCO zaradí)
 * ostáva pre TÚTO cestu úplne nedotknutá, mení sa len HTTP run-now tlačidlo.
 *
 * Zvažovaná a zamietnutá alternatíva ("peek": `pg_try_advisory_lock` →
 * okamžité `pg_advisory_unlock` → spustiť pôvodný, blokujúci `runXxx()`)
 * necháva TOCTOU race okno medzi uvoľnením peek-zámku a opätovným získaním
 * vnútri `runXxx()` — issue 413 explicitne žiada "never blocking-wait" ako
 * ZÁRUKU, nie len pravdepodobnosť, viď design komentár na tikete.
 */
export interface RunNowJob<T> {
  readonly jobName: string;
  readonly lockKey: number;
  /** Odomknuté jadro (`runXxxLocked`) — pozri modulový komentár vyššie. */
  readonly run: (now: Date) => Promise<T>;
}

export type RunNowOutcome<T> =
  | { readonly status: "success"; readonly result: T }
  | { readonly status: "failure"; readonly error: unknown };

export type RunNowStart = { readonly status: "started" } | { readonly status: "busy"; readonly message: string };

function formatBratislavaTime(instant: Date): string {
  const { hour, minute } = getZonedDateParts(instant);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(hour)}:${pad(minute)}`;
}

async function buildBusyMessage(db: Database, jobName: string): Promise<string> {
  const currentRun = await getLatestJobRun(db, jobName);
  if (currentRun !== null && currentRun.status === "running") {
    return `Beh už prebieha (spustený o ${formatBratislavaTime(new Date(currentRun.startedAt))}) — počkajte na jeho dokončenie.`;
  }
  // Zámok drží niekto, koho `job_run` riadok si (race medzi peek a týmto
  // dopytom) tento dopyt ešte nevidel, alebo ho vôbec nevkladá — všeobecná
  // správa je stále pravdivá a nikdy neluže operátorovi presný, no zastaraný čas.
  return "Beh už prebieha — počkajte na jeho dokončenie.";
}

export async function startRunNow<T>(
  db: Database,
  job: RunNowJob<T>,
  now: Date,
  onSettled: (outcome: RunNowOutcome<T>) => void | Promise<void>,
): Promise<RunNowStart> {
  const lockClient = await db.$client.connect();
  const lockResult = await lockClient.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [job.lockKey]);
  const acquired = lockResult.rows[0]?.locked === true;

  if (!acquired) {
    lockClient.release();
    return { status: "busy", message: await buildBusyMessage(db, job.jobName) };
  }

  let runId: string | undefined;
  try {
    const [inserted] = await db.insert(jobRuns).values({ jobName: job.jobName, startedAt: now, status: "running" }).returning({ id: jobRuns.id });
    runId = inserted?.id;
  } catch (insertError) {
    // Zámok bol UŽ získaný, ale "running" riadok sa nepodarilo vložiť —
    // `job.run()` sa NIKDY nespustí, takže fire-and-forget reťaz nižšie (a
    // jej `.finally()`, ktoré by inak zámok uvoľnilo) sa vôbec nezostaví.
    // Bez tohto by zámok ostal držaný NAVŽDY (rovnaký kľúč používa aj
    // NAPLÁNOVANÝ beh, takže by sa zablokoval tiež) — uvoľni ho TU a
    // vyhoď ďalej, presne ako "busy" vetva vyššie robí `lockClient
    // .release()` pred návratom.
    await lockClient.query("select pg_advisory_unlock($1)", [job.lockKey]).catch(() => undefined);
    lockClient.release();
    throw insertError;
  }

  // Fire-and-forget — HTTP handler NIKDY nečaká na toto (issue 413's hlavná
  // oprava). `lockClient` zostáva pripojený/zamknutý po CELÝ beh, uvoľní sa
  // AŽ v poslednom `.finally()` nižšie.
  void job
    .run(now)
    .then(
      async (result) => {
        if (runId !== undefined) {
          await db.update(jobRuns).set({ status: "success", finishedAt: new Date(), detail: result }).where(eq(jobRuns.id, runId));
        }
        await onSettled({ status: "success", result });
      },
      async (error: unknown) => {
        const rawErrorMessage = error instanceof Error ? error.message : String(error);
        log.error({ jobName: job.jobName, rawErrorMessage }, "run-now: beh na pozadí zlyhal");
        if (runId !== undefined) {
          await db.update(jobRuns).set({ status: "failure", finishedAt: new Date(), errorMessage: rawErrorMessage }).where(eq(jobRuns.id, runId));
        }
        await onSettled({ status: "failure", error });
      },
    )
    .catch((residualError: unknown) => {
      // Obranná sieť — nemala by nikdy vystreliť (obe vetvy vyššie sa už
      // snažia zapísať výsledok), ale zvyškové zlyhanie tu (napr. samotný
      // UPDATE `job_run` vyhodí) nesmie nikdy uniknúť ako unhandled rejection.
      const rawErrorMessage = residualError instanceof Error ? residualError.message : String(residualError);
      log.error({ jobName: job.jobName, rawErrorMessage }, "run-now: zápis výsledku behu zlyhal");
    })
    .finally(() => {
      void lockClient
        .query("select pg_advisory_unlock($1)", [job.lockKey])
        .catch((unlockError: unknown) => {
          const rawErrorMessage = unlockError instanceof Error ? unlockError.message : String(unlockError);
          log.error({ jobName: job.jobName, rawErrorMessage }, "run-now: uvoľnenie advisory zámku zlyhalo");
        })
        .finally(() => {
          lockClient.release();
        });
    });

  return { status: "started" };
}
