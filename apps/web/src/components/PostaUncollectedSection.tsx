import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { formatSkDateTime } from "../formatDate.js";
import {
  fetchPostaUncollectedPreview,
  fetchPostaUncollectedStatus,
  PostaUncollectedUnauthorizedError,
  runPostaUncollectedNow,
  setPostaUncollectedEnabled,
  type PostaUncollectedPreview,
  type PostaUncollectedStatus,
} from "../postaUncollectedApi.js";
import { PostaUncollectedRow } from "./PostaUncollectedRow.js";

// Rovnaké dve role, ktoré server vyžaduje pre Štart/Stop + "Spustiť teraz"
// (`requireRole("admin", "manazer")`, `posta-uncollected-routes.ts`) —
// čítanie (tabuľka) smie vidieť KAŽDÝ prihlásený zamestnanec (rovnaká
// úroveň ako "Sync zo Shoptetu"), preto sa táto množina používa LEN na
// skrytie mutujúcich tlačidiel, nikdy na skrytie celej sekcie.
const CONTROL_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

export function PostaUncollectedSection({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<PostaUncollectedStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [toggleBusy, setToggleBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runNotice, setRunNotice] = useState("");
  const [preview, setPreview] = useState<PostaUncollectedPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const canControl = CONTROL_ROLES.has(role);

  const load = useCallback(() => {
    fetchPostaUncollectedStatus()
      .then((s) => {
        setStatus(s);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof PostaUncollectedUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Nevyzdvihnuté zásielky sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(load, [load]);

  const toggle = useCallback(() => {
    if (status === null) return;
    setToggleBusy(true);
    setPostaUncollectedEnabled(!status.enabled)
      .then(load)
      .catch((err: unknown) => {
        if (err instanceof PostaUncollectedUnauthorizedError) {
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
    runPostaUncollectedNow()
      .then((result) => {
        setRunNotice(
          `Skontrolovaných ${String(result.stats.checked)}, nevyzdvihnutých ${String(result.stats.uncollectedCount)}, e-mailov odoslaných ${String(result.stats.emailsSent)}.`,
        );
        load();
      })
      .catch((err: unknown) => {
        if (err instanceof PostaUncollectedUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setRunNotice(err instanceof Error ? err.message : "Beh zlyhal.");
      })
      .finally(() => {
        setRunBusy(false);
      });
  }, [load, onSessionExpired]);

  const openPreview = useCallback(
    (packageNumber: string) => {
      setPreviewError("");
      fetchPostaUncollectedPreview(packageNumber)
        .then(setPreview)
        .catch((err: unknown) => {
          if (err instanceof PostaUncollectedUnauthorizedError) {
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
  if (status === null) return <p role="alert">Nevyzdvihnuté zásielky sa nepodarili načítať.</p>;

  const result = status.lastRun?.result ?? null;

  return (
    <section>
      <div className="autohead">
        <span className={"pill" + (status.enabled ? "" : " off")} data-testid="posta-status-pill">
          {status.enabled ? "Beží" : "Zastavené"}
        </span>
        {canControl && (
          <button type="button" className="btn sm" disabled={toggleBusy} onClick={toggle} data-testid="posta-toggle">
            {status.enabled ? "⏹ Stop" : "▶️ Štart"}
          </button>
        )}
        {canControl && (
          <button type="button" className="btn sm ghost" disabled={runBusy} onClick={runNow} data-testid="posta-run-now">
            {runBusy ? "Spúšťam…" : "⚡ Spustiť teraz"}
          </button>
        )}
      </div>

      {status.lastRun !== null && (
        <p className="posta-last-run">
          Posledný beh: {formatSkDateTime(status.lastRun.startedAt)} —{" "}
          {status.lastRun.status === "failure" ? "❌ chyba" : status.lastRun.skippedReason !== null ? `⏸ ${status.lastRun.skippedReason}` : "✅ OK"}
        </p>
      )}
      {runNotice !== "" && <p role="status">{runNotice}</p>}

      {result?.bccMissing === true && (
        <p role="alert" data-testid="posta-bcc-missing">
          ⚠️ Chýba adresa pre skrytú kópiu majiteľovi (POSTA_UNCOLLECTED_BCC_EMAIL) — automatizácia zatiaľ NEPOSIELA
          žiadne e-maily zákazníkom.
        </p>
      )}
      {result?.mailNotConfigured === true && (
        <p role="alert" data-testid="posta-mail-not-configured">
          ⚠️ Odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST).
        </p>
      )}
      {result?.coverage.degraded === true && (
        <p role="alert" data-testid="posta-coverage-degraded">
          ⚠️ Zdroj zásielok vyzerá degradovaný — {String(result.coverage.dispatchedWithoutPackage)} z{" "}
          {String(result.coverage.dispatchedOrders)} odoslaných objednávok nemá číslo zásielky. Automatizácia možno
          „oslepla".
        </p>
      )}
      {result?.coverage.dispatchedStatusUnknown === true && (
        <p role="alert" data-testid="posta-status-unknown">
          ⚠️ Takmer žiadna objednávka v okne nie je rozpoznaná ako „odoslaná" — over nastavenie stavov objednávok.
        </p>
      )}

      {result === null && <p data-testid="posta-empty">Zatiaľ žiadny beh — spustite kontrolu tlačidlom „⚡ Spustiť teraz".</p>}

      {result !== null && result.uncollected.length === 0 && (
        <p data-testid="posta-none-uncollected">Žiadna zásielka momentálne nečaká na vyzdvihnutie.</p>
      )}

      {result !== null && result.uncollected.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Zásielka</th>
              <th>Pošta</th>
              <th>Objednávka</th>
              <th>Zákazník</th>
              <th>Dní čaká</th>
              <th>Vyzdvihnúť do</th>
              <th>E-maily</th>
              <th>Posledný e-mail</th>
              <th>Náhľad</th>
            </tr>
          </thead>
          <tbody>
            {result.uncollected.map((shipment) => (
              <PostaUncollectedRow key={shipment.packageNumber} shipment={shipment} onPreview={openPreview} />
            ))}
          </tbody>
        </table>
      )}

      {result !== null && result.invalid.length > 0 && (
        <div className="card posta-box" data-testid="posta-invalid-box">
          <h3>Nesledovateľné čísla zásielky ({result.invalid.length})</h3>
          <ul>
            {result.invalid.map((row) => (
              <li key={row.packageNumber}>
                {row.orderCode} — {row.name} — {row.packageNumber}{" "}
                <a href={row.adminLink} target="_blank" rel="noreferrer">
                  objednávka
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result !== null && result.errors.length > 0 && (
        <div className="card posta-box" data-testid="posta-errors-box">
          <h3>Chyby pri overovaní ({result.errors.length})</h3>
          <ul>
            {result.errors.map((row) => (
              <li key={row.packageNumber}>
                {row.orderCode} — {row.packageNumber} — {row.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {previewError !== "" && <p role="alert">{previewError}</p>}
      {preview !== null && (
        <div className="mail-preview posta-preview" data-testid="posta-preview">
          <h3>
            Náhľad e-mailu #{preview.count} {preview.maxReached && "(posledný odoslaný — kadencia vyčerpaná)"}
          </h3>
          <p>
            Komu: {preview.recipient} — Predmet: {preview.subject}
          </p>
          {/* `preview.html` je appkou generovaný e-mail (`buildEmail`, `modules/posta-uncollected/logic.ts`) —
              KAŽDÁ interpolovaná hodnota (meno, číslo zásielky, pošta) je tam už HTML-escapovaná,
              nikdy surový užívateľský vstup priamo tu. Ukazuje sa PRESNE to, čo by dostal zákazník. */}
          <div className="posta-preview-body" dangerouslySetInnerHTML={{ __html: preview.html }} />
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
