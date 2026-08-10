import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { formatSkDateTime } from "../formatDate.js";
import {
  fetchRestockStatus,
  fetchRestockWaiting,
  RestockUnauthorizedError,
  runRestockNow,
  setRestockEnabled,
  type RestockStatus,
  type RestockWaitingPage,
} from "../restockApi.js";
import { feedOnlyProductLink, ourProductLink } from "../shopLinks.js";

// Majiteľ si chce vzorku preklikať po stovkách („potváram si zo sto a overím"),
// takže stránka je 100 riadkov, nie tradičných 20.
const PAGE_SIZE = 100;

// Rovnaké dve role, ktoré server vyžaduje pre Štart/Stop + "Spustiť teraz"
// (`requireRole("admin", "manazer")`, `restock-routes.ts`).
const CONTROL_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

// issue 226: ľudské popisky nášho `variant.state` pre kartu rozporov s feedom.
const STATE_LABEL: Readonly<Record<"sellable" | "out_of_stock" | "discontinued", string>> = {
  sellable: "predajné",
  out_of_stock: "vypredané",
  discontinued: "ukončený predaj",
};

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
  const [waitingList, setWaitingList] = useState<RestockWaitingPage | null>(null);
  const [supplier, setSupplier] = useState("");
  const [offset, setOffset] = useState(0);
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

  useEffect(() => {
    let current = true;
    fetchRestockWaiting({ limit: PAGE_SIZE, offset, supplier })
      .then((page) => {
        // Odpoveď na starší filter nesmie prepísať novší zoznam.
        if (current) setWaitingList(page);
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof RestockUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Zoznam pripravených na prepnutie sa nepodarilo načítať.");
      });
    return () => {
      current = false;
    };
  }, [offset, supplier, onSessionExpired]);

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

  const { enabled, maxPerRun, waiting, feedConflicts, events, lastRun } = status;

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
          Posledný beh: {formatSkDateTime(lastRun.startedAt)} —{" "}
          {lastRun.status === "failure"
            ? "❌ chyba"
            : lastRun.skippedReason !== null
              ? `⏸ ${lastRun.skippedReason}`
              : "✅ OK"}
        </p>
      )}
      {runNotice !== "" && <p role="status">{runNotice}</p>}

      {/* issue 226: Shoptetov VLASTNÝ feed pre porovnávače hovorí niečo iné,
          než náš odvodený stav — nezávislý dôkaz, že sa odvodenie znova
          rozišlo s realitou (presne trieda chyby z issue 219). Rozporný
          variant sa NESTANE kandidátom na prepnutie, kým sa nevysvetlí. */}
      <div className="card" data-testid="restock-feed-conflicts">
        <h3>Rozpory nášho stavu s feedom Shoptetu{feedConflicts.total > 0 && ` (${String(feedConflicts.total)})`}</h3>
        {feedConflicts.total === 0 ? (
          <p className="empty">Žiadne — náš stav sa všade zhoduje s feedom.</p>
        ) : (
          <>
            <p>
              Feed pre porovnávače hovorí niečo iné než my — tieto varianty sa nestanú kandidátmi na
              prepnutie, kým sa rozpor nevysvetlí.
            </p>
            <div className="fs-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Kód</th>
                    <th scope="col">Názov</th>
                    <th scope="col">Náš stav</th>
                    <th scope="col">Feed hovorí</th>
                    <th scope="col">Náš produkt</th>
                  </tr>
                </thead>
                <tbody>
                  {feedConflicts.rows.map((row) => (
                    <tr key={row.variantCode} data-testid={`restock-feed-conflict-${row.variantCode}`}>
                      <td>{row.variantCode}</td>
                      <td>{row.productName}</td>
                      <td>{STATE_LABEL[row.ourState]}</td>
                      <td>{row.feedAvailability}</td>
                      <td>
                        <a href={row.ourUrl} target="_blank" rel="noreferrer noopener">
                          náš ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3>Prepnuté produkty</h3>
        {events.length === 0 ? (
          <p className="empty">Zatiaľ nič — automatizácia ešte nič neprepla.</p>
        ) : (
          <div className="fs-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Kedy</th>
                  <th scope="col">Kód</th>
                  <th scope="col">Názov</th>
                  <th scope="col">Dodávateľ</th>
                  <th scope="col">Náš produkt</th>
                  <th scope="col">Čo dodávateľ hlásil</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => {
                  const nasOdkaz = feedOnlyProductLink(event.ourUrl);
                  return (
                    <tr key={event.id} data-testid={`restock-event-${event.variantCode}`}>
                      <td>{formatSkDateTime(event.at)}</td>
                      <td>{event.variantCode}</td>
                      <td>{event.productName}</td>
                      <td>{event.supplier ?? "—"}</td>
                      <td>
                        {nasOdkaz === null ? (
                          "—"
                        ) : (
                          <a href={nasOdkaz} target="_blank" rel="noreferrer noopener">
                            náš ↗
                          </a>
                        )}
                      </td>
                      <td>
                        <a href={event.supplierLink} target="_blank" rel="noreferrer noopener">
                          {event.supplierAvailabilityText === "" ? "skladom" : event.supplierAvailabilityText}
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" data-testid="restock-waiting-list">
        <h3>Pripravené na prepnutie{waitingList === null ? "" : ` (${String(waitingList.total)})`}</h3>
        <p>
          Zoznam na ručné overenie: vľavo odkaz na náš produkt, vpravo na stránku dodávateľa.
          Otvárajú sa do novej karty, takže zoznam ti pod rukami nezmizne.
        </p>

        <div className="autohead">
          <label>
            Dodávateľ:{" "}
            <select
              data-testid="restock-waiting-supplier"
              value={supplier}
              onChange={(e) => {
                setSupplier(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">Všetci</option>
              {(waitingList?.suppliers ?? []).map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({s.count})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn sm ghost"
            disabled={offset === 0}
            onClick={() => {
              setOffset(Math.max(0, offset - PAGE_SIZE));
            }}
            data-testid="restock-waiting-prev"
          >
            ← Predošlých {PAGE_SIZE}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={waitingList === null || offset + PAGE_SIZE >= waitingList.total}
            onClick={() => {
              setOffset(offset + PAGE_SIZE);
            }}
            data-testid="restock-waiting-next"
          >
            Ďalších {PAGE_SIZE} →
          </button>
          {waitingList !== null && waitingList.total > 0 && (
            <span className="chip" data-testid="restock-waiting-range">
              {offset + 1}–{Math.min(offset + waitingList.rows.length, waitingList.total)} z {waitingList.total}
            </span>
          )}
        </div>

        {waitingList === null ? (
          <p role="status">Načítavam zoznam…</p>
        ) : waitingList.rows.length === 0 ? (
          <p className="empty">Nič nečaká — žiadny vypredaný produkt nemá čerstvé potvrdenie od dodávateľa.</p>
        ) : (
          <div className="fs-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Kód</th>
                  <th scope="col">Názov</th>
                  <th scope="col">Dodávateľ</th>
                  <th scope="col">Náš produkt</th>
                  <th scope="col">U dodávateľa</th>
                  <th scope="col">Čo hlási</th>
                </tr>
              </thead>
              <tbody>
                {waitingList.rows.map((row) => (
                  <tr key={row.variantCode} data-testid={`restock-waiting-${row.variantCode}`}>
                    <td>{row.variantCode}</td>
                    <td>{row.productName}</td>
                    <td>{row.supplier ?? "—"}</td>
                    <td>
                      <a href={ourProductLink(row.variantCode, row.ourUrl)} target="_blank" rel="noreferrer noopener">
                        náš ↗
                      </a>
                    </td>
                    <td>
                      <a href={row.supplierLink} target="_blank" rel="noreferrer noopener">
                        dodávateľ ↗
                      </a>
                    </td>
                    <td>
                      {row.supplierAvailabilityText === "" ? "skladom" : row.supplierAvailabilityText}
                      {row.supplierPrice !== null && ` · ${row.supplierPrice}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
