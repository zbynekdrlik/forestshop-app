import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import {
  fetchRestockStatus,
  RestockUnauthorizedError,
  runRestockNow,
  setRestockEnabled,
  type RestockStatus,
} from "../restockApi.js";

// Rovnaké dve role, ktoré server vyžaduje pre Štart/Stop + "Spustiť teraz"
// (`requireRole("admin", "manazer")`, `restock-routes.ts`).
const CONTROL_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("sk-SK");
}

export function RestockSection({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<RestockStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [toggleBusy, setToggleBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runNotice, setRunNotice] = useState("");
  const canControl = CONTROL_ROLES.has(role);

  const load = useCallback(() => {
    fetchRestockStatus()
      .then((s) => {
        setStatus(s);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof RestockUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Prepínanie sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(load, [load]);

  const toggle = useCallback(() => {
    if (status === null) return;
    setToggleBusy(true);
    setRestockEnabled(!status.enabled)
      .then(load)
      .catch((err: unknown) => {
        if (err instanceof RestockUnauthorizedError) {
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
    runRestockNow()
      .then((result) => {
        if (result.status === "ok") {
          setRunNotice(
            result.overLimit > 0
              ? `Prepnutých ${String(result.switched)} produktov, ďalších ${String(result.overLimit)} čaká na ďalší beh (strop).`
              : `Prepnutých ${String(result.switched)} produktov.`,
          );
        } else if (result.status === "nothing_to_do") {
          setRunNotice("Nebolo čo prepnúť — žiadny vypredaný produkt nemá čerstvé potvrdenie od dodávateľa.");
        } else {
          setRunNotice(`Zápis do Shoptetu zlyhal (${result.errorDetail}). Nič sa nepreplo, skúsi sa znova.`);
        }
        load();
      })
      .catch((err: unknown) => {
        if (err instanceof RestockUnauthorizedError) {
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

  const { enabled, maxPerRun, waiting, events, lastRun } = status;

  return (
    <div data-testid="restock-section">
      {error !== "" && <p role="alert">{error}</p>}

      <p>
        Keď dodávateľ dostane tovar naspäť na sklad, náš vypredaný produkt sa sám prepne na
        „Skladom". Prepne sa najviac {maxPerRun} produktov za jeden beh; zvyšok počká na ďalšiu noc.
        Produkty, ktoré si vedome vypol (viditeľné len cez priamy odkaz, skryté, s ukončeným
        predajom), sa neprepnú nikdy.
      </p>

      <div className="autohead">
        <span className={"pill" + (enabled ? "" : " off")} data-testid="restock-status-pill">
          {enabled ? "Beží" : "Zastavené"}
        </span>
        {canControl && (
          <button type="button" className="btn sm" disabled={toggleBusy} onClick={toggle} data-testid="restock-toggle">
            {enabled ? "⏹ Stop" : "▶️ Štart"}
          </button>
        )}
        {canControl && (
          <button
            type="button"
            className="btn sm ghost"
            disabled={runBusy}
            onClick={runNow}
            data-testid="restock-run-now"
          >
            {runBusy ? "Prepínam…" : "⚡ Spustiť teraz"}
          </button>
        )}
        <span className="chip" data-testid="restock-waiting">
          Pripravených na prepnutie: {waiting.now}
          {waiting.overLimit > 0 && ` (+${String(waiting.overLimit)} nad strop)`}
        </span>
      </div>

      {lastRun !== null && (
        <p data-testid="restock-last-run">
          Posledný beh: {formatDateTime(lastRun.startedAt)} —{" "}
          {lastRun.status === "failure"
            ? "❌ chyba"
            : lastRun.skippedReason !== null
              ? `⏸ ${lastRun.skippedReason}`
              : "✅ OK"}
        </p>
      )}
      {runNotice !== "" && <p role="status">{runNotice}</p>}

      <div className="card">
        <h3>Prepnuté produkty</h3>
        {events.length === 0 ? (
          <p className="empty">Zatiaľ nič — automatizácia ešte nič neprepla.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Kedy</th>
                <th scope="col">Kód</th>
                <th scope="col">Názov</th>
                <th scope="col">Dodávateľ</th>
                <th scope="col">Čo dodávateľ hlásil</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} data-testid={`restock-event-${event.variantCode}`}>
                  <td>{formatDateTime(event.at)}</td>
                  <td>{event.variantCode}</td>
                  <td>{event.productName}</td>
                  <td>{event.supplier ?? "—"}</td>
                  <td>
                    <a href={event.supplierLink} target="_blank" rel="noreferrer noopener">
                      {event.supplierAvailabilityText === "" ? "skladom" : event.supplierAvailabilityText}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
