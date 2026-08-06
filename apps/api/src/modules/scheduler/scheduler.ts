import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { jobRuns } from "../../db/schema.js";
import { log } from "../../logger.js";
import { getZonedDateParts, zonedDateKey } from "../../timezone.js";
import type { Schedule, ScheduledJob } from "./types.js";

// Zámok naplánovaných úloh — VLASTNÝ, samostatný kľúč (advisory zámky zdieľajú
// JEDEN priestor bez ohľadu na to, ktorá funkcia ho vzala, `.claude/rules/
// testing.md`), musí zostať odlišný od INGEST_ADVISORY_LOCK_KEY (787_878_001,
// ingest.ts) aj TEST_DB_ISOLATION_LOCK_KEY (787_878_100, tests/helpers/db.ts).
export const SCHEDULER_ADVISORY_LOCK_KEY = 787_878_002;

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Kľúč periódy podľa druhu rozvrhu — issue 293: `daily` periodizuje podľa
// MIESTNEHO (Europe/Bratislava) kalendárneho dňa (predtým UTC deň — beh
// tesne po slovenskej polnoci, ale ešte pred UTC polnocou, dostal VČEREJŠÍ
// kľúč a úloha sa mohla spustiť DRUHÝKRÁT v ten istý slovenský deň).
// `hourly` (#115) ZOSTÁVA podľa UTC dňa+hodiny, ZÁMERNE nelokalizované —
// hodinový job nemá cieľovú hodinu (beží KAŽDÚ hodinu), lokalizácia kľúča by
// v deň prechodu na ZIMNÝ čas (miestna hodina 02:00-03:00 sa v UTC termínoch
// vyskytne DVAKRÁT) spôsobila, že druhý skutočný beh sa nesprávne považuje
// za duplicitný tej istej periódy. UTC hodina je jednoznačná a monotónna,
// presne to hodinový job potrebuje — `zonedDateKey` (nová, lokalizovaná
// cesta) sa preto používa LEN pre `daily`.
// Rovnaký beh v RÔZNYCH periódach (napr. 23:00 včera vs. 01:00 dnes pri
// `daily`, alebo 10:xx vs. 11:xx pri `hourly`) má rôzny kľúč → znova splatná.
function periodKey(schedule: Schedule, d: Date): string {
  if (schedule.kind === "daily") return zonedDateKey(d);
  return `${utcDateKey(d)}T${String(d.getUTCHours()).padStart(2, "0")}`;
}

// Splatná = aktuálna perióda (deň pri `daily`, deň+hodina pri `hourly`) ešte
// nemá ŽIADEN riadok (running, success AJ failure sa počítajú — zlyhaný beh
// sa v tejto perióde už neopakuje, čaká na ďalšiu, presne ako úspešný) A
// aktuálny čas v rámci periódy dosiahol naplánovanú minútu (`daily` navyše aj
// hodinu). Prvá podmienka (nie druhá) je to, čo úlohu robí odolnou voči
// reštartu kontajnera — splatnosť sa odvodzuje z PERZISTOVANÉHO posledného
// behu, nie z pamäte procesu.
export function isDue(
  schedule: Schedule,
  now: Date,
  lastRun: { readonly startedAt: Date } | null,
): boolean {
  if (lastRun !== null && periodKey(schedule, lastRun.startedAt) === periodKey(schedule, now)) return false;
  if (schedule.kind === "daily") {
    // issue 293: cieľová aj aktuálna hodina/minúta sa porovnávajú v
    // MIESTNOM (Europe/Bratislava) čase, nie v UTC — `hourLocal`/
    // `minuteLocal` (types.ts) sú teraz slovenský čas, presne to, čo
    // majiteľ v `jobs.ts` nastavuje.
    const targetMinuteOfDay = schedule.hourLocal * 60 + schedule.minuteLocal;
    const { hour, minute } = getZonedDateParts(now);
    const nowMinuteOfDay = hour * 60 + minute;
    return nowMinuteOfDay >= targetMinuteOfDay;
  }
  // Minúta v rámci hodiny je pre Europe/Bratislava (celohodinový offset)
  // časovo-pásmovo NEZÁVISLÁ — UTC minúta == miestna minúta, netreba
  // lokalizovať (viď komentár na `HourlySchedule.minuteUtc` v types.ts).
  return now.getUTCMinutes() >= schedule.minuteUtc;
}

/**
 * Jeden tick: pre každú úlohu skontroluje splatnosť a vloží "running" riadok —
 * kontrola aj vloženie bežia v JEDNEJ transakcii pod
 * `pg_advisory_xact_lock(SCHEDULER_ADVISORY_LOCK_KEY)`, rovnaký vzor, aký
 * `ingest.ts` už používa pre import. Druhá súčasne bežiaca replika (druhý
 * tick v tom istom okamihu) sa na zámku zablokuje, počká, kým prvá transakcia
 * commitne, a potom uvidí dnešný riadok už vložený — úlohu teda nezopakuje.
 * Samotné spustenie úlohy (`job.run`) beží AŽ PO commite, mimo zámku — dlho
 * bežiaci import (54 MB stiahnutie) tak zámok nedrží celý svoj beh.
 */
export async function tick(db: Database, jobs: readonly ScheduledJob[], now: Date): Promise<void> {
  const due: { readonly job: ScheduledJob; readonly runId: string }[] = [];

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SCHEDULER_ADVISORY_LOCK_KEY})`);
    for (const job of jobs) {
      const [lastRun] = await tx
        .select({ startedAt: jobRuns.startedAt })
        .from(jobRuns)
        .where(eq(jobRuns.jobName, job.name))
        .orderBy(desc(jobRuns.startedAt))
        .limit(1);
      if (!isDue(job.schedule, now, lastRun ?? null)) continue;
      const [inserted] = await tx
        .insert(jobRuns)
        .values({ jobName: job.name, startedAt: now, status: "running" })
        .returning({ id: jobRuns.id });
      if (inserted !== undefined) due.push({ job, runId: inserted.id });
    }
  });

  for (const { job, runId } of due) {
    await executeJob(db, job, runId, now);
  }
}

async function executeJob(db: Database, job: ScheduledJob, runId: string, startedAt: Date): Promise<void> {
  try {
    const outcome = await job.run(db, startedAt);
    await db
      .update(jobRuns)
      .set({ status: "success", finishedAt: new Date(), detail: outcome.detail ?? null })
      .where(eq(jobRuns.id, runId));
    log.info({ jobName: job.name, runId }, "naplánovaná úloha dobehla úspešne");
  } catch (error) {
    // Rovnaká disciplína ako `catalog-routes.ts`'s fetch-failure vetva —
    // surová chyba sa loguje samostatne, nikdy sa neinterpoluje inam.
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error({ jobName: job.name, runId, rawErrorMessage }, "naplánovaná úloha zlyhala");
    await db
      .update(jobRuns)
      .set({ status: "failure", finishedAt: new Date(), errorMessage: rawErrorMessage })
      .where(eq(jobRuns.id, runId));
  }
}

export interface SchedulerHandle {
  readonly stop: () => void;
}

/**
 * Spustí periodický tick na pozadí. Chyba VNÚTRI `tick` samotného (napr.
 * výpadok databázového pripojenia počas kontroly splatnosti) sa zaloguje a
 * tick sa jednoducho zopakuje pri ďalšom intervale — nikdy nesmie zhodiť
 * `setInterval`-ový časovač ani celý proces appky.
 */
export function startScheduler(
  db: Database,
  jobs: readonly ScheduledJob[],
  options: { readonly tickIntervalMs?: number } = {},
): SchedulerHandle {
  const tickIntervalMs = options.tickIntervalMs ?? 5 * 60 * 1000;
  const timer = setInterval(() => {
    tick(db, jobs, new Date()).catch((error: unknown) => {
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      log.error({ rawErrorMessage }, "tick plánovača zlyhal");
    });
  }, tickIntervalMs);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
