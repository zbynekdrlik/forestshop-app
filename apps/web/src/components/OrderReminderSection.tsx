import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { formatSkDateTime } from "../formatDate.js";
import {
  fetchOrderReminderPreview,
  fetchOrderReminderStatus,
  overrideOrderReminder,
  OrderReminderUnauthorizedError,
  runOrderReminderNow,
  setOrderReminderEnabled,
  type OrderReminderPreview,
  type OrderReminderStatus,
} from "../orderReminderApi.js";
import { OrderReminderEmailedRow, OrderReminderNoEmailRow, OrderReminderNoteRow, OrderReminderSkippedRow } from "./OrderReminderRow.js";

// Rovnaké dve role, ktoré server vyžaduje pre Štart/Stop + ručné akcie
// (`requireRole("admin", "manazer")`, `order-reminder-routes.ts`) — čítanie
// (tabuľky) smie vidieť KAŽDÝ prihlásený zamestnanec, rovnaká úroveň ako #172.
const CONTROL_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

export function OrderReminderSection({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<OrderReminderStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [toggleBusy, setToggleBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runNotice, setRunNotice] = useState("");
  const [busyOrderCode, setBusyOrderCode] = useState("");
  const [actionError, setActionError] = useState("");
  const [preview, setPreview] = useState<OrderReminderPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const canControl = CONTROL_ROLES.has(role);

  const load = useCallback(() => {
    fetchOrderReminderStatus()
      .then((s) => {
        setStatus(s);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof OrderReminderUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Pripomienky objednávok sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(load, [load]);

  const toggle = useCallback(() => {
    if (status === null) return;
    setToggleBusy(true);
    setOrderReminderEnabled(!status.enabled)
      .then(load)
      .catch((err: unknown) => {
        if (err instanceof OrderReminderUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError(err instanceof Error ? err.message : "Zmena sa nepodarila.");
      })
      .finally(() => {
        setToggleBusy(false);
      });
  }, [status, load, onSessionExpired]);

  const runNow = useCallback(() => {
    setRunBusy(true);
    setRunNotice("");
    runOrderReminderNow()
      .then((result) => {
        setRunNotice(
          `Skontrolovaných ${String(result.stats.candidates)}, e-mailov odoslaných ${String(result.stats.emailedNow)}, kontaktovaných (AI) ${String(result.stats.contactedNow)}.`,
        );
        load();
      })
      .catch((err: unknown) => {
        if (err instanceof OrderReminderUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setRunNotice(err instanceof Error ? err.message : "Beh zlyhal.");
      })
      .finally(() => {
        setRunBusy(false);
      });
  }, [load, onSessionExpired]);

  const runAction = useCallback(
    (orderCode: string, action: "contact" | "send") => {
      setActionError("");
      setBusyOrderCode(orderCode);
      overrideOrderReminder(orderCode, action)
        .then((result) => {
          if (!result.ok) {
            setActionError(result.error);
            return;
          }
          load();
        })
        .catch((err: unknown) => {
          if (err instanceof OrderReminderUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Akcia zlyhala.");
        })
        .finally(() => {
          setBusyOrderCode("");
        });
    },
    [load, onSessionExpired],
  );

  const openPreview = useCallback(
    (orderCode: string) => {
      setPreviewError("");
      fetchOrderReminderPreview(orderCode)
        .then(setPreview)
        .catch((err: unknown) => {
          if (err instanceof OrderReminderUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setPreviewError(err instanceof Error ? err.message : "Náhľad sa nepodarilo načítať.");
        });
    },
    [onSessionExpired],
  );

  if (!loaded) return <p>Načítavam…</p>;
  if (error !== "") return <p role="alert">{error}</p>;
  if (status === null) return <p role="alert">Pripomienky objednávok sa nepodarili načítať.</p>;

  const result = status.lastRun?.result ?? null;

  return (
    <section>
      <div className="autohead">
        <span className={"pill" + (status.enabled ? "" : " off")} data-testid="order-reminder-status-pill">
          {status.enabled ? "Beží" : "Zastavené"}
        </span>
        {canControl && (
          <button type="button" className="btn sm" disabled={toggleBusy} onClick={toggle} data-testid="order-reminder-toggle">
            {status.enabled ? "⏹ Stop" : "▶️ Štart"}
          </button>
        )}
        {canControl && (
          <button type="button" className="btn sm ghost" disabled={runBusy} onClick={runNow} data-testid="order-reminder-run-now">
            {runBusy ? "Spúšťam…" : "⚡ Spustiť teraz"}
          </button>
        )}
      </div>

      {status.lastRun !== null && (
        <p className="order-reminder-last-run">
          Posledný beh: {formatSkDateTime(status.lastRun.startedAt)} —{" "}
          {status.lastRun.status === "failure" ? "❌ chyba" : status.lastRun.skippedReason !== null ? `⏸ ${status.lastRun.skippedReason}` : "✅ OK"}
        </p>
      )}
      {runNotice !== "" && <p role="status">{runNotice}</p>}
      {actionError !== "" && <p role="alert">{actionError}</p>}

      {result?.aiNotConfigured === true && (
        <p role="alert" data-testid="order-reminder-ai-not-configured">
          ⚠️ AI klasifikácia nie je nakonfigurovaná (chýba OPENAI_API_KEY) — objednávky s poznámkou čakajú.
        </p>
      )}
      {result?.bccMissing === true && (
        <p role="alert" data-testid="order-reminder-bcc-missing">
          ⚠️ Chýba adresa pre skrytú kópiu majiteľovi (ORDER_REMINDER_BCC_EMAIL) — automatizácia zatiaľ NEPOSIELA žiadne e-maily zákazníkom.
        </p>
      )}
      {result?.mailNotConfigured === true && (
        <p role="alert" data-testid="order-reminder-mail-not-configured">
          ⚠️ Odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST).
        </p>
      )}

      {result === null && <p data-testid="order-reminder-empty">Zatiaľ žiadny beh — spustite kontrolu tlačidlom „⚡ Spustiť teraz".</p>}

      {result !== null && (
        <>
          <h3>🔴 Bez poznámky ({result.noNote.length})</h3>
          {result.noNote.length === 0 ? (
            <p data-testid="order-reminder-no-note-empty">Žiadna objednávka bez poznámky.</p>
          ) : (
            <div className="fs-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Objednávka</th>
                    <th>Zákazník</th>
                    <th>Telefón</th>
                    <th>E-mail</th>
                    <th>Položka</th>
                    <th>Dní nečinnosti</th>
                    <th>Akcia</th>
                  </tr>
                </thead>
                <tbody>
                  {result.noNote.map((row) => (
                    <OrderReminderNoteRow
                      key={row.orderCode}
                      row={row}
                      busy={busyOrderCode === row.orderCode}
                      onSend={(code) => {
                        runAction(code, "send");
                      }}
                      onContact={(code) => {
                        runAction(code, "contact");
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result.noEmail.length > 0 && (
            <div className="card order-reminder-box" data-testid="order-reminder-no-email-box">
              <h3>✉️ Bez e-mailovej adresy ({result.noEmail.length})</h3>
              <div className="fs-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Objednávka</th>
                      <th>Zákazník</th>
                      <th>Telefón</th>
                      <th>Položka</th>
                      <th>Dní nečinnosti</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.noEmail.map((row) => (
                      <OrderReminderNoEmailRow key={row.orderCode} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result.emailed.length > 0 && (
            <div className="card order-reminder-box" data-testid="order-reminder-emailed-box">
              <h3>🟠 Pripomienka odoslaná ({result.emailed.length})</h3>
              <div className="fs-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Objednávka</th>
                      <th>Zákazník</th>
                      <th>E-mail</th>
                      <th>Položka</th>
                      <th>Odoslané</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.emailed.map((row) => (
                      <OrderReminderEmailedRow key={row.orderCode} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(result.contacted.length > 0 || result.pending.length > 0) && (
            <div className="card order-reminder-box" data-testid="order-reminder-skipped-box">
              <h3>Preskočené ({result.contacted.length + result.pending.length})</h3>
              <div className="fs-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Objednávka</th>
                      <th>Zákazník</th>
                      <th>Dôvod</th>
                      <th>Dní nečinnosti</th>
                      <th>Akcia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.contacted.map((row) => (
                      <OrderReminderSkippedRow
                        key={row.orderCode}
                        row={row}
                        icon={row.resolvedBy === "manual" ? "✋" : "⚪"}
                        reason={row.resolvedBy === "manual" ? "vybavil ručne človek" : "AI usúdila, že zákazník je už kontaktovaný"}
                        busy={busyOrderCode === row.orderCode}
                        onPreview={openPreview}
                        onSend={(code) => {
                          runAction(code, "send");
                        }}
                      />
                    ))}
                    {result.pending.map((row) => (
                      <OrderReminderSkippedRow
                        key={row.orderCode}
                        row={row}
                        icon="⚠️"
                        reason={row.reason}
                        busy={busyOrderCode === row.orderCode}
                        onPreview={openPreview}
                        onSend={(code) => {
                          runAction(code, "send");
                        }}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {previewError !== "" && <p role="alert">{previewError}</p>}
      {preview !== null && (
        <div className="mail-preview order-reminder-preview" data-testid="order-reminder-preview">
          <h3>Náhľad pripomienkového e-mailu</h3>
          <p>
            Komu: {preview.recipient} — Predmet: {preview.subject}
          </p>
          {/* `preview.html` je appkou generovaný e-mail (`buildReminderEmail`,
              `modules/order-reminder/logic.ts`) — meno aj kód objednávky sú tam
              už HTML-escapované, nikdy surový užívateľský vstup priamo tu. */}
          <div className="order-reminder-preview-body" dangerouslySetInnerHTML={{ __html: preview.html }} />
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setPreview(null);
            }}
          >
            Zavrieť náhľad
          </button>
        </div>
      )}
    </section>
  );
}
