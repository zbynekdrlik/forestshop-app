import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { formatSkDateTime } from "../formatDate.js";
import { detailText, jobLabel, STATUS_LABELS } from "../schedulerLabels.js";
import { fetchJobRuns, SchedulerUnauthorizedError, type JobRun } from "../schedulerApi.js";

// Rovnaké dve role, ktoré server vyžaduje pre `GET /api/scheduler/runs`
// (`requireRole("admin", "manazer")`, `scheduler-routes.ts`) — server ostáva
// skutočnou bránou, toto len skrýva sekciu pre role, ktoré by aj tak dostali 403.
const SCHEDULER_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

export function SchedulerSection({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element | null {
  const [runs, setRuns] = useState<readonly JobRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const canView = SCHEDULER_ROLES.has(role);

  const load = useCallback(() => {
    // Rovnaká brána ako server (`requireRole` v `scheduler-routes.ts`) — bez
    // nej by neprivilegovaná rola pri KAŽDOM vykreslení znova vyvolala
    // zbytočnú požiadavku, ktorá aj tak dostane 403.
    if (!canView) return;
    fetchJobRuns()
      .then((items) => {
        setRuns(items);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof SchedulerUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Prehľad plánovača sa nepodarilo načítať.");
      });
  }, [canView, onSessionExpired]);

  useEffect(load, [load]);

  if (!canView) return null;

  return (
    <section>
      <h2>Plánovač</h2>
      {!loaded && <p>Načítavam prehľad plánovača…</p>}
      {error !== "" && <p role="alert">{error}</p>}
      {loaded && runs.length === 0 && (
        <p data-testid="scheduler-empty">Žiadny beh zatiaľ nie je zaznamenaný.</p>
      )}
      {runs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Úloha</th>
              <th>Naposledy spustená</th>
              <th>Stav</th>
              <th>Dokončená</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.jobName} data-testid={`job-${run.jobName}`}>
                <td>{jobLabel(run.jobName)}</td>
                <td>{formatSkDateTime(run.startedAt)}</td>
                <td>{STATUS_LABELS[run.status]}</td>
                <td>
                  {formatSkDateTime(run.finishedAt)}
                </td>
                <td>{detailText(run)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
