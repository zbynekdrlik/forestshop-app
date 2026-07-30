import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import {
  fetchOpenOrders,
  OrdersUnauthorizedError,
  updateOrderLineState,
  type OrderLine,
  type SupplierOpenOrders,
} from "../ordersApi.js";

const STATE_LABELS: Record<OrderLine["state"], string> = {
  objednane: "Objednané",
  caka_sa: "Čaká sa",
  skladom: "Skladom",
  nedostupne: "Nedostupné",
};

// Rovnaké dve role, ktoré server vyžaduje pre
// `POST /api/orders/lines/:lineId/state` (`requireRole("admin", "manazer")`,
// `orders-routes.ts`) — server ostáva skutočnou bránou, toto len skrýva
// ovládací prvok pre role, ktoré by aj tak dostali 403 (rovnaký vzor ako
// `CatalogPage`'s `IMPORT_ROLES`/`SchedulerSection`'s `SCHEDULER_ROLES`).
const CAN_CHANGE_STATE_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

// #25: kopírovanie objednávky presunuté do #31 (otvorená otázka pre
// majiteľa — presný výstup nie je definovaný), preto tu stále nie je žiadne
// tlačidlo "kopírovať".
export function OrdersSection({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [suppliers, setSuppliers] = useState<readonly SupplierOpenOrders[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [stateError, setStateError] = useState("");
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const canChangeState = CAN_CHANGE_STATE_ROLES.has(role);

  const load = useCallback(() => {
    fetchOpenOrders()
      .then((items) => {
        setSuppliers(items);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof OrdersUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Otvorené objednávky sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(load, [load]);

  const changeState = useCallback(
    (lineId: string, newState: OrderLine["state"]) => {
      setStateError("");
      setBusyLineId(lineId);
      updateOrderLineState(lineId, newState)
        .then(() => {
          // Lokálna aktualizácia namiesto plného refetchu — server už
          // potvrdil zápis (aj audit), netreba znova ťahať celý zoznam.
          setSuppliers((current) =>
            current.map((group) => ({
              ...group,
              lines: group.lines.map((line) => (line.lineId === lineId ? { ...line, state: newState } : line)),
            })),
          );
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setStateError(err instanceof Error ? err.message : "Zmena stavu sa nepodarila.");
        })
        .finally(() => {
          setBusyLineId(null);
        });
    },
    [onSessionExpired],
  );

  // `/api/orders/open` už zoraďuje riadky presne tak, ako majú byť zobrazené
  // (dodávateľ vzostupne, potom najnovšia objednávka prvá) — žiadne ďalšie
  // preskupovanie na klientovi.
  const totalLines = suppliers.reduce((sum, group) => sum + group.lines.length, 0);

  return (
    <section>
      <h2>Na objednanie</h2>
      {!loaded && <p>Načítavam otvorené objednávky…</p>}
      {error !== "" && <p role="alert">{error}</p>}
      {stateError !== "" && <p role="alert">{stateError}</p>}
      {loaded && totalLines === 0 && (
        <p data-testid="orders-empty">Zatiaľ nie sú žiadne otvorené objednávky.</p>
      )}
      {suppliers.map((group) => (
        <div key={group.supplier} data-testid={`supplier-${group.supplier}`}>
          <h3>{group.supplier}</h3>
          <table>
            <thead>
              <tr>
                <th>Objednávka</th>
                <th>Zákazník</th>
                <th>Kód</th>
                <th>Produkt</th>
                <th>Veľkosť</th>
                <th>Množstvo</th>
                <th>Stav</th>
                <th>Objednané</th>
                <th>Komentár</th>
              </tr>
            </thead>
            <tbody>
              {group.lines.map((line) => (
                <tr key={line.lineId} data-testid={`order-line-${line.lineId}`}>
                  <td>{line.externalOrderId}</td>
                  <td>{line.customerName}</td>
                  <td>{line.variantCode}</td>
                  <td>{line.variantName}</td>
                  <td>{line.sizeLabel ?? "—"}</td>
                  <td>{line.quantity}</td>
                  <td>
                    {canChangeState ? (
                      <select
                        // Code review finding (#25): pôvodne bez slova "stav"
                        // v aria-labeli (obchádzka Playwright's substring
                        // `getByLabel("Stav")` kolízie s katalógovým filtrom),
                        // čo by čítačke obrazovky neoznámilo, čo tento prvok
                        // robí. Skutočná oprava patrí na stranu KOLÍDUJÚCEHO
                        // testu (`catalog.spec.ts` teraz používa
                        // `{ exact: true }`), nie na obetovanie prístupnosti
                        // tu — tento select smie mať plnohodnotný popis.
                        aria-label={`Zmeniť stav riadku objednávky ${line.externalOrderId} / ${line.variantCode}`}
                        data-testid={`state-select-${line.lineId}`}
                        value={line.state}
                        disabled={busyLineId === line.lineId}
                        onChange={(e) => {
                          changeState(line.lineId, e.target.value as OrderLine["state"]);
                        }}
                      >
                        {(Object.keys(STATE_LABELS) as OrderLine["state"][]).map((s) => (
                          <option key={s} value={s}>
                            {STATE_LABELS[s]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      STATE_LABELS[line.state]
                    )}
                  </td>
                  <td>{new Date(line.placedAt).toLocaleDateString("sk-SK")}</td>
                  <td>{line.comment ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
