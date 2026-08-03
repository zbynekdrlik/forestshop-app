import { useCallback, useEffect, useState, type JSX } from "react";
import {
  fetchMailLog,
  MailLogUnauthorizedError,
  MAIL_LOG_SOURCES,
  MAIL_LOG_SOURCE_LABELS,
  type MailLogList,
  type MailLogPeriod,
  type MailLogRow,
  type MailLogSource,
} from "../mailLogApi.js";

// issue 193, majiteľ: "v automatizaciach dufam su vsetky potrebne statistiky
// komu sa poslal mail a tak dalej". Jedna obrazovka pre VŠETKÝCH odosielateľov
// appky — bez nej sa história odoslanej pošty nedala zistiť vôbec.

const STATUS_LABELS: Readonly<Record<MailLogRow["status"], string>> = {
  sent: "Odoslané",
  failed: "Zlyhalo",
  skipped: "Preskočené",
};

const PERIOD_LABELS: readonly { readonly value: MailLogPeriod; readonly label: string }[] = [
  { value: "7", label: "posledných 7 dní" },
  { value: "30", label: "posledných 30 dní" },
  { value: "90", label: "posledných 90 dní" },
  { value: "all", label: "celá história" },
];

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("sk-SK", { dateStyle: "short", timeStyle: "short" });
}

/** Čoho sa e-mail týkal — objednávka, tovar, zásielka. Prázdny reťazec, keď
 * odosielateľ nič z toho nemá (objednávka dodávateľovi). */
function subjectOfRow(row: MailLogRow): string {
  const parts: string[] = [];
  if (row.orderCode !== null) parts.push(`objednávka ${row.orderCode}`);
  if (row.variantCode !== null) parts.push(`tovar ${row.variantCode}`);
  if (row.packageNumber !== null) parts.push(`zásielka ${row.packageNumber}`);
  return parts.join(" · ");
}

export function MailLogSection({ onSessionExpired }: { readonly onSessionExpired: () => void }): JSX.Element {
  const [data, setData] = useState<MailLogList | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [source, setSource] = useState<MailLogSource | "">("");
  const [status, setStatus] = useState<MailLogRow["status"] | "">("");
  const [period, setPeriod] = useState<MailLogPeriod>("30");

  const load = useCallback(() => {
    fetchMailLog({ source, status, period })
      .then((list) => {
        setData(list);
        setError("");
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof MailLogUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Prehľad odoslaných e-mailov sa nepodarilo načítať.");
      });
  }, [onSessionExpired, source, status, period]);

  useEffect(load, [load]);

  if (!loaded) return <p>Načítavam…</p>;
  if (error !== "") return <p role="alert">{error}</p>;
  if (data === null) return <p role="alert">Prehľad odoslaných e-mailov sa nepodarilo načítať.</p>;

  return (
    <section>
      <p>
        Každý e-mail, ktorý appka poslala v mene obchodu — komu, kedy, čoho sa týkal a či odoslanie prešlo. Zapisujú sa aj pokusy, ktoré neprešli, aj tie, ktoré
        appka zámerne neposlala (napríklad aby zákazník nedostal to isté dvakrát).
      </p>

      <div className="ml-summary" data-testid="mail-log-summary">
        <span className="ml-chip ml-chip-sent" data-testid="mail-log-sum-sent">
          Odoslané: {data.summary.sent}
        </span>
        <span className="ml-chip ml-chip-failed" data-testid="mail-log-sum-failed">
          Zlyhalo: {data.summary.failed}
        </span>
        <span className="ml-chip ml-chip-skipped" data-testid="mail-log-sum-skipped">
          Preskočené: {data.summary.skipped}
        </span>
        <span className="ml-chip" data-testid="mail-log-sum-duplicates" title="Koľkokrát appka zabránila druhému rovnakému e-mailu tomu istému zákazníkovi">
          Zabránené duplicity: {data.summary.duplicatesBlocked}
        </span>
      </div>

      <div className="ml-filters">
        <label>
          Automatizácia
          <select
            value={source}
            data-testid="mail-log-filter-source"
            onChange={(e) => {
              setSource(e.target.value as MailLogSource | "");
            }}
          >
            <option value="">všetky</option>
            {MAIL_LOG_SOURCES.map((s) => (
              <option key={s} value={s}>
                {MAIL_LOG_SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Stav
          <select
            value={status}
            data-testid="mail-log-filter-status"
            onChange={(e) => {
              setStatus(e.target.value as MailLogRow["status"] | "");
            }}
          >
            <option value="">všetky</option>
            <option value="sent">odoslané</option>
            <option value="failed">zlyhalo</option>
            <option value="skipped">preskočené</option>
          </select>
        </label>
        <label>
          Obdobie
          <select
            value={period}
            data-testid="mail-log-filter-period"
            onChange={(e) => {
              setPeriod(e.target.value as MailLogPeriod);
            }}
          >
            {PERIOD_LABELS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {data.rows.length === 0 ? (
        <p data-testid="mail-log-empty">Za zvolené obdobie appka neposlala ani sa nepokúsila poslať žiadny e-mail.</p>
      ) : (
        <div className="ml-table-wrap">
          <table className="ml-table" data-testid="mail-log-table">
            <thead>
              <tr>
                <th>Kedy</th>
                <th>Automatizácia</th>
                <th>Komu</th>
                <th>Čoho sa týka</th>
                <th>Stav</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id} data-testid={`mail-log-row-${row.id}`} className={`ml-row ml-row-${row.status}`}>
                  <td className="ml-when">
                    {formatWhen(row.createdAt)}
                    <span className="ml-trigger">{row.trigger === "manual" ? (row.actorName ?? "ručne") : "plán"}</span>
                  </td>
                  <td>
                    {MAIL_LOG_SOURCE_LABELS[row.source]}
                    {row.sequence !== null && <span className="ml-seq">{row.sequence}. upozornenie</span>}
                  </td>
                  <td className="ml-recipient">{row.recipient === "" ? "—" : row.recipient}</td>
                  <td>
                    {row.adminLink === null ? (
                      subjectOfRow(row) === "" ? (
                        (row.subject ?? "—")
                      ) : (
                        subjectOfRow(row)
                      )
                    ) : (
                      <a href={row.adminLink} target="_blank" rel="noreferrer noopener">
                        {subjectOfRow(row)}
                      </a>
                    )}
                  </td>
                  <td>
                    <span className={`ml-status ml-status-${row.status}`}>{STATUS_LABELS[row.status]}</span>
                    {row.reason !== null && <span className="ml-reason">{row.reason}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
