import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { CatalogUnauthorizedError, triggerCatalogIngest, type CatalogIngestOutcome } from "../catalogApi.js";
import { formatSkDateTime } from "../formatDate.js";
import { OrdersUnauthorizedError, triggerOrdersIngest, type OrdersIngestOutcome } from "../ordersApi.js";
import { fetchJobRuns, SchedulerUnauthorizedError, type JobRun } from "../schedulerApi.js";
import { detailText, jobLabel, STATUS_LABELS } from "../schedulerLabels.js";
import { CATALOG_STALE_AFTER_MS, computeSyncStatus, ORDERS_STALE_AFTER_MS } from "../syncStatus.js";

// Rovnaké dve role, ktoré server vyžaduje pre `GET /api/scheduler/runs`
// AJ pre obe ručné tlačidlá importu (`requireRole("admin", "manazer")`,
// `scheduler-routes.ts`/`catalog-routes.ts`/`orders-routes.ts`) — server
// ostáva skutočnou bránou, toto len skrýva obrazovku pre role, ktoré by aj
// tak dostali 403.
const SYNC_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

const CATALOG_JOB_NAME = "catalog-import";
const ORDERS_JOB_NAME = "orders-import";

interface Notice {
  readonly kind: "info" | "warning";
  readonly text: string;
}

function describeCatalogOutcome(result: CatalogIngestOutcome): Notice {
  switch (result.status) {
    case "accepted":
      return {
        kind: "info",
        text: `Import bol úspešný — export obsahoval ${String(result.variantCount)} variantov, ${String(result.productCount)} produktov, ${String(result.missingCount)} novo chýbajúcich, ${String(result.issueCount)} anomálií.`,
      };
    case "rejected":
      return { kind: "warning", text: `Import bol zamietnutý — dôvod: ${result.reason}` };
    case "duplicate":
      return { kind: "info", text: "Export sa od posledného importu nezmenil — katalóg zostáva nezmenený." };
    case "busy":
      return { kind: "warning", text: "Import už prebieha na pozadí — počkajte, kým sa dokončí, a skúste to znova." };
  }
}

function describeOrdersOutcome(result: OrdersIngestOutcome): Notice {
  switch (result.status) {
    case "accepted":
      return {
        kind: "info",
        text: `Import bol úspešný — export obsahoval ${String(result.orderCount)} objednávok, ${String(result.lineCount)} riadkov, ${String(result.issueCount)} anomálií.`,
      };
    case "rejected":
      return { kind: "warning", text: `Import bol zamietnutý — dôvod: ${result.reason}` };
    case "busy":
      return { kind: "warning", text: "Import už prebieha na pozadí — počkajte, kým sa dokončí, a skúste to znova." };
  }
}

function lastRunLine(run: JobRun | undefined): string {
  if (run === undefined) return "Posledný beh: zatiaľ nikdy";
  const cas = formatSkDateTime(run.startedAt);
  const verdikt = run.status === "running" ? "⏳ beží…" : run.status === "success" ? "✅ OK" : "❌ CHYBA";
  return `Posledný beh: ${cas} — ${verdikt}`;
}

function IngestChannel({
  title,
  run,
  busy,
  notice,
  onRun,
  now,
  staleAfterMs,
}: {
  readonly title: string;
  readonly run: JobRun | undefined;
  readonly busy: boolean;
  readonly notice: Notice | null;
  readonly onRun: () => void;
  readonly now: Date;
  readonly staleAfterMs: number;
}): JSX.Element {
  // #115: JEDINÝ zdroj pravdy pre pill — `computeSyncStatus` porovnáva vek
  // POSLEDNÉHO úspešného behu s prahom (`staleAfterMs`), namiesto pôvodného
  // "OK, pokiaľ posledný beh neskončil chybou" bez ohľadu na to, ako dávno.
  const status = computeSyncStatus(run, now, staleAfterMs);
  return (
    <div className="autostatus" data-testid={`sync-channel-${title}`}>
      <div className="autohead">
        <h3>{title}</h3>
        <span className={"pill " + status.pillClass}>{status.pillText}</span>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={onRun}>
          {busy ? "Sťahujem…" : "⚡ Stiahnuť teraz"}
        </button>
      </div>
      <div className="autometa">{lastRunLine(run)}</div>
      {run?.status === "failure" && <div className="autoerr">❌ {run.errorMessage ?? "Beh zlyhal."}</div>}
      {status.warningText !== null && (
        <p role="alert" className="autostale" data-testid={`sync-stale-${title}`}>
          {status.warningText}
        </p>
      )}
      {notice !== null && (
        <p role={notice.kind === "warning" ? "alert" : "status"}>{notice.text}</p>
      )}
    </div>
  );
}

export function SyncSection({
  role,
  onSessionExpired,
  now = new Date(),
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
  // #115: voliteľné, na testovateľnosť staleness kontroly (bez neho by
  // testy so ZAFIXOVANÝMI dátumami vo fixtúrach postupne "zostarli" spolu so
  // skutočným časom behu CI — presne ten druh časovanej bomby, kvôli ktorej
  // tento ticket vôbec vznikol).
  readonly now?: Date;
}): JSX.Element {
  const [runs, setRuns] = useState<readonly JobRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogNotice, setCatalogNotice] = useState<Notice | null>(null);
  const [ordersBusy, setOrdersBusy] = useState(false);
  const [ordersNotice, setOrdersNotice] = useState<Notice | null>(null);
  const canView = SYNC_ROLES.has(role);

  const load = useCallback(() => {
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
        setError("Prehľad synchronizácie sa nepodarilo načítať.");
      });
  }, [canView, onSessionExpired]);

  useEffect(load, [load]);

  const runCatalog = useCallback(() => {
    setCatalogBusy(true);
    setCatalogNotice(null);
    triggerCatalogIngest()
      .then((result) => {
        setCatalogNotice(describeCatalogOutcome(result));
        load();
      })
      .catch((err: unknown) => {
        if (err instanceof CatalogUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setCatalogNotice({ kind: "warning", text: err instanceof Error ? err.message : "Import sa nepodarilo spustiť." });
      })
      .finally(() => {
        setCatalogBusy(false);
      });
  }, [load, onSessionExpired]);

  const runOrders = useCallback(() => {
    setOrdersBusy(true);
    setOrdersNotice(null);
    triggerOrdersIngest()
      .then((result) => {
        setOrdersNotice(describeOrdersOutcome(result));
        load();
      })
      .catch((err: unknown) => {
        if (err instanceof OrdersUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setOrdersNotice({ kind: "warning", text: err instanceof Error ? err.message : "Import sa nepodarilo spustiť." });
      })
      .finally(() => {
        setOrdersBusy(false);
      });
  }, [load, onSessionExpired]);

  if (!canView) {
    return <p>Táto obrazovka je dostupná len pre rolu admin alebo manažér.</p>;
  }

  const catalogRun = runs.find((r) => r.jobName === CATALOG_JOB_NAME);
  const ordersRun = runs.find((r) => r.jobName === ORDERS_JOB_NAME);

  return (
    <section>
      {!loaded && <p>Načítavam prehľad synchronizácie…</p>}
      {error !== "" && <p role="alert">{error}</p>}
      {loaded && (
        <>
          <IngestChannel
            title="Katalóg"
            run={catalogRun}
            busy={catalogBusy}
            notice={catalogNotice}
            onRun={runCatalog}
            now={now}
            staleAfterMs={CATALOG_STALE_AFTER_MS}
          />
          <IngestChannel
            title="Objednávky"
            run={ordersRun}
            busy={ordersBusy}
            notice={ordersNotice}
            onRun={runOrders}
            now={now}
            staleAfterMs={ORDERS_STALE_AFTER_MS}
          />

          <h3>História behov</h3>
          {runs.length === 0 ? (
            <p className="empty" data-testid="sync-history-empty">Žiadny beh zatiaľ nie je zaznamenaný.</p>
          ) : (
            <div className="fs-table-wrap">
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
                    <tr key={run.jobName} data-testid={`sync-job-${run.jobName}`}>
                      <td>{jobLabel(run.jobName)}</td>
                      <td>{formatSkDateTime(run.startedAt)}</td>
                      <td>{STATUS_LABELS[run.status]}</td>
                      <td>{formatSkDateTime(run.finishedAt)}</td>
                      <td>{detailText(run)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
