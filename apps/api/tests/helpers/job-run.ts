import type { Database } from "../../src/db/client.js";
import { getLatestJobRun, type JobRunSummary } from "../../src/modules/scheduler/queries.js";

/**
 * issue 413: run-now beží odteraz ASYNC (server vráti 202 hneď, beh
 * pokračuje na pozadí, mimo `await`-u HTTP handlera) — integračný test,
 * čo predtým čítal výsledok priamo z POST odpovede, musí namiesto toho
 * počkať, kým sa `job_run` riadok posunie z "running" do konečného stavu.
 * Bounded poll (nikdy nekonečné čakanie) — testovaný beh v týchto testoch
 * je vždy s fejkovanými/rýchlymi závislosťami, takže reálne dobehne za pár
 * milisekúnd; strop je len obranná poistka proti zaseknutému testu.
 */
export async function waitForJobRunSettled(db: Database, jobName: string, maxAttempts = 100): Promise<JobRunSummary> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const run = await getLatestJobRun(db, jobName);
    if (run !== null && run.status !== "running") return run;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`job_run "${jobName}" sa nedostal do konečného stavu do ${String(maxAttempts)} pokusov`);
}
