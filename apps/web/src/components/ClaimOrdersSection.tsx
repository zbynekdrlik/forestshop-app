import { useCallback, useContext, useEffect, useState, type JSX, type SyntheticEvent } from "react";
import type { Me } from "../api.js";
import { formatSkDate } from "../formatDate.js";
import {
  clearOrderClaim,
  fetchClaimOrders,
  markOrderClaim,
  OrderFlagsUnauthorizedError,
  type ClaimOrderRow,
} from "../orderFlagsApi.js";
import { OrderFlagsBadgeRefreshContext } from "../orderFlagsBadgeContext.js";

// issue 290: "Eshop → Reklamácie" — Shoptet nemá pre reklamácie žiadny
// použiteľný stav/príznak (overené naživo na produkcii, tiket), appka si
// preto vedie VLASTNÚ značku (`order.claim_marked_at`/`claim_note`,
// `modules/orders/order-flags-state.ts`). Na rozdiel od Výmena/Vrátený
// tovar (čisto READ-ONLY pohľad na Shoptet stav) má táto obrazovka JEDINÚ
// mutáciu appky mimo Upozornení — obsluha si sama označí/zruší reklamáciu,
// nikdy AI dohad.
const CONTROL_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

export function ClaimOrdersSection({ role, onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  const [rows, setRows] = useState<readonly ClaimOrderRow[] | null>(null);
  const [error, setError] = useState("");
  const [orderCode, setOrderCode] = useState("");
  const [note, setNote] = useState("");
  const [markError, setMarkError] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyClearId, setBusyClearId] = useState("");
  const canControl = CONTROL_ROLES.has(role);
  const badgeRefresh = useContext(OrderFlagsBadgeRefreshContext);

  const load = useCallback(() => {
    fetchClaimOrders()
      .then(setRows)
      .catch((err: unknown) => {
        if (err instanceof OrderFlagsUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Zoznam reklamácií sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(load, [load]);

  const mark = useCallback(
    (e: SyntheticEvent) => {
      e.preventDefault();
      if (orderCode.trim() === "") return;
      setBusy(true);
      setMarkError("");
      markOrderClaim(orderCode.trim(), note)
        .then((result) => {
          if (!result.ok) {
            setMarkError(result.error);
            return;
          }
          setOrderCode("");
          setNote("");
          load();
          badgeRefresh.refresh();
        })
        .catch((err: unknown) => {
          if (err instanceof OrderFlagsUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setMarkError(err instanceof Error ? err.message : "Označenie zlyhalo.");
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [orderCode, note, load, onSessionExpired, badgeRefresh],
  );

  const clear = useCallback(
    (orderId: string) => {
      setBusyClearId(orderId);
      clearOrderClaim(orderId)
        .then(() => {
          load();
          badgeRefresh.refresh();
        })
        .catch((err: unknown) => {
          if (err instanceof OrderFlagsUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setError(err instanceof Error ? err.message : "Zrušenie reklamácie zlyhalo.");
        })
        .finally(() => {
          setBusyClearId("");
        });
    },
    [load, onSessionExpired, badgeRefresh],
  );

  if (error !== "") return <p role="alert">{error}</p>;
  if (rows === null) return <p>Načítavam…</p>;

  return (
    <section>
      <p>Objednávky ručne označené ako reklamácia — Shoptet pre reklamácie nemá vlastný stav, appka si ich preto vedie sama.</p>

      {canControl && (
        <form className="card" onSubmit={mark}>
          <label>
            Číslo objednávky
            <input
              type="text"
              value={orderCode}
              onChange={(e) => {
                setOrderCode(e.target.value);
              }}
              data-testid="claim-order-code"
            />
          </label>
          <label>
            Poznámka (nepovinné)
            <input
              type="text"
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
              }}
              data-testid="claim-note-input"
            />
          </label>
          {markError !== "" && <p role="alert">{markError}</p>}
          <button type="submit" className="btn" disabled={busy || orderCode.trim() === ""} data-testid="claim-mark-submit">
            Označiť ako reklamáciu
          </button>
        </form>
      )}

      {rows.length === 0 ? (
        <p data-testid="claims-empty">Momentálne nie je označená žiadna reklamácia.</p>
      ) : (
        <div className="fs-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Objednávka</th>
                <th>Zákazník</th>
                <th>Dátum</th>
                <th>Suma</th>
                <th>Stav</th>
                <th>Poznámka</th>
                {canControl && <th>Akcia</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`claim-row-${row.externalOrderId}`}>
                  <td>
                    <a href={row.adminUrl} target="_blank" rel="noreferrer">
                      č. {row.externalOrderId}
                    </a>
                  </td>
                  <td>{row.customerName}</td>
                  <td>{formatSkDate(row.placedAt)}</td>
                  <td>{row.totalPriceWithVat === null ? "—" : `${row.totalPriceWithVat} €`}</td>
                  <td>{row.statusName}</td>
                  <td>{row.claimNote === null || row.claimNote === "" ? "—" : row.claimNote}</td>
                  {canControl && (
                    <td>
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={busyClearId === row.id}
                        onClick={() => {
                          clear(row.id);
                        }}
                        data-testid={`claim-clear-${row.externalOrderId}`}
                      >
                        Zrušiť reklamáciu
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
