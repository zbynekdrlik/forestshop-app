import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import {
  fetchSupplierStockStatus,
  runSupplierStockNow,
  SupplierStockUnauthorizedError,
  type SupplierAvailability,
  type SupplierStockStatus,
} from "../supplierStockApi.js";

// Rovnaké dve role, ktoré server vyžaduje pre "Spustiť teraz"
// (`requireRole("admin", "manazer")`, `supplier-stock-routes.ts`) — prehľad
// smie vidieť KAŽDÝ prihlásený zamestnanec, preto sa množina používa len na
// skrytie tlačidla, nikdy celej obrazovky.
const CONTROL_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

const AVAILABILITY_LABEL: Readonly<Record<SupplierAvailability, string>> = {
  available: "Skladom",
  unavailable: "Vypredané",
  unknown: "Neviem",
};

function formatDateTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("sk-SK");
}

export function SupplierStockSection({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<SupplierStockStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runNotice, setRunNotice] = useState("");
  const canControl = CONTROL_ROLES.has(role);

  const load = useCallback(() => {
    fetchSupplierStockStatus()
      .then((s) => {
        setStatus(s);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof SupplierStockUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Dodávateľský sklad sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(load, [load]);

  const runNow = useCallback(() => {
    setRunBusy(true);
    setRunNotice("");
    runSupplierStockNow()
      .then((result) => {
        setRunNotice(
          `Skontrolovaných ${String(result.checked)} odkazov · skladom ${String(result.available)} · vypredané ${String(result.unavailable)} · neviem ${String(result.unknown)} · zlyhalo ${String(result.failed)}.`,
        );
        load();
      })
      .catch((err: unknown) => {
        if (err instanceof SupplierStockUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError(err instanceof Error ? err.message : "Beh sa nepodarilo spustiť.");
      })
      .finally(() => {
        setRunBusy(false);
      });
  }, [load, onSessionExpired]);

  if (!loaded) return <p role="status">Načítavam…</p>;
  if (status === null) return <p role="alert">{error === "" ? "Nepodarilo sa načítať." : error}</p>;

  const { overview, unreadable, rows, lastRun } = status;

  return (
    <div data-testid="supplier-stock-section">
      {error !== "" && <p role="alert">{error}</p>}

      <p>
        Každú noc sa skontroluje, či dodávatelia majú tovar skladom. Údaj sa číta priamo zo stránky
        dodávateľa — čo sa prečítať nedá, ostáva ako <strong>Neviem</strong> a nikdy nič neprepne.
      </p>

      <div className="autohead">
        <span className="chip" data-testid="ss-total">
          Sledovaných odkazov: {overview.total}
        </span>
        <span className="chip" data-testid="ss-available">
          Skladom: {overview.available}
        </span>
        <span className="chip" data-testid="ss-unavailable">
          Vypredané: {overview.unavailable}
        </span>
        <span className="chip" data-testid="ss-unknown">
          Neviem: {overview.unknown}
        </span>
        <span className="chip" data-testid="ss-failed">
          Zlyhalo: {overview.failed}
        </span>
        {canControl && (
          <button
            type="button"
            className="btn sm ghost"
            disabled={runBusy}
            onClick={runNow}
            data-testid="ss-run-now"
          >
            {runBusy ? "Kontrolujem…" : "⚡ Spustiť teraz"}
          </button>
        )}
      </div>

      <p data-testid="ss-last-checked">Naposledy kontrolované: {formatDateTime(overview.lastCheckedAt)}</p>
      {lastRun !== null && (
        <p data-testid="ss-last-run">
          Posledný beh: {formatDateTime(lastRun.startedAt)} —{" "}
          {lastRun.status === "failure" ? "❌ chyba" : lastRun.status === "running" ? "⏳ beží" : "✅ OK"}
          {lastRun.errorMessage !== null && ` (${lastRun.errorMessage})`}
        </p>
      )}
      {runNotice !== "" && <p role="status">{runNotice}</p>}

      {/* Výslovná požiadavka majiteľa (3. 8. 2026) namiesto AI: nech je vidno,
          ktoré stránky sa prečítať nedajú, aby sa dalo rozhodnúť, pre ktorého
          dodávateľa sa oplatí dorobiť čítanie ručne. */}
      <div className="card" data-testid="ss-unreadable">
        <h3>Stránky, ktoré neviem prečítať</h3>
        {unreadable.length === 0 ? (
          <p className="empty">Zatiaľ žiadne — všetky sledované odkazy sa darí prečítať.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Dodávateľ</th>
                <th scope="col">Odkazov</th>
                <th scope="col">Ukážky</th>
              </tr>
            </thead>
            <tbody>
              {unreadable.map((host) => (
                <tr key={host.host} data-testid={`ss-unreadable-${host.host}`}>
                  <td>{host.host}</td>
                  <td>{host.count}</td>
                  <td>
                    {host.samples.map((sample) => (
                      <div key={`${sample.link}|${sample.sizeLabel}`}>
                        <a href={sample.link} target="_blank" rel="noreferrer noopener">
                          {sample.link}
                        </a>
                        {sample.sizeLabel !== "" && ` [${sample.sizeLabel}]`}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Sledované odkazy</h3>
        {rows.length === 0 ? (
          <p className="empty">Zatiaľ nič — kontrola ešte nebežala.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Dodávateľ</th>
                <th scope="col">Odkaz</th>
                <th scope="col">Veľkosť</th>
                <th scope="col">Dostupnosť</th>
                <th scope="col">Cena</th>
                <th scope="col">Kontrolované</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                // Kľúč MUSÍ niesť aj veľkosť — odkaz s pravidlom na veľkosti
                // (issue 224) má pre TÚ ISTÚ linku viac riadkov naraz.
                <tr key={`${row.link}|${row.sizeLabel}`} data-testid={`ss-row-${row.link}-${row.sizeLabel}`}>
                  <td>{row.host}</td>
                  <td>
                    <a href={row.link} target="_blank" rel="noreferrer noopener">
                      {row.link}
                    </a>
                  </td>
                  <td>{row.sizeLabel === "" ? "—" : row.sizeLabel}</td>
                  <td>
                    {row.ok ? AVAILABILITY_LABEL[row.availability] : "Kontrola zlyhala"}
                    {row.availabilityText !== "" && ` (${row.availabilityText})`}
                  </td>
                  <td>{row.price === null ? "—" : `${row.price} €`}</td>
                  <td>{formatDateTime(row.checkedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
