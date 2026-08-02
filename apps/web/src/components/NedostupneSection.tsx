import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import {
  fetchNedostupneList,
  fetchNedostupnePreview,
  NedostupneUnauthorizedError,
  sendNedostupneEmail,
  type NedostupneEmailType,
  type NedostupneGroup,
  type NedostupneList,
  type NedostupnePreview,
} from "../nedostupneApi.js";

// Rovnaké dve role, ktoré server vyžaduje na odoslanie (`requireRole("admin",
// "manazer")`, `nedostupne-routes.ts`) — čítanie (zoznam) smie vidieť KAŽDÝ
// prihlásený zamestnanec, rovnaká úroveň ako #172/#173.
const CONTROL_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

interface PendingSend {
  readonly orderCode: string;
  readonly variantCode: string;
  readonly emailType: NedostupneEmailType;
  readonly preview: NedostupnePreview;
}

function itemLabel(group: NedostupneGroup): string {
  return group.sizeLabel === null ? group.itemName : `${group.itemName} — veľkosť ${group.sizeLabel}`;
}

export function NedostupneSection({ role, onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  const [list, setList] = useState<NedostupneList | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState<PendingSend | null>(null);
  const canControl = CONTROL_ROLES.has(role);

  const load = useCallback(() => {
    fetchNedostupneList()
      .then((l) => {
        setList(l);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof NedostupneUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Nedostupné tovary sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(load, [load]);

  const openPreview = useCallback(
    (orderCode: string, variantCode: string, emailType: NedostupneEmailType) => {
      const key = `${orderCode}|${variantCode}|${emailType}`;
      setActionError("");
      setBusyKey(key);
      fetchNedostupnePreview(orderCode, variantCode, emailType)
        .then((preview) => {
          setPending({ orderCode, variantCode, emailType, preview });
        })
        .catch((err: unknown) => {
          if (err instanceof NedostupneUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Náhľad sa nepodarilo načítať.");
        })
        .finally(() => {
          setBusyKey("");
        });
    },
    [onSessionExpired],
  );

  const confirmSend = useCallback(() => {
    if (pending === null) return;
    const key = `${pending.orderCode}|${pending.variantCode}|${pending.emailType}`;
    setBusyKey(key);
    sendNedostupneEmail(pending.orderCode, pending.variantCode, pending.emailType)
      .then((result) => {
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        setPending(null);
        load();
      })
      .catch((err: unknown) => {
        if (err instanceof NedostupneUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setActionError(err instanceof Error ? err.message : "Odoslanie zlyhalo.");
      })
      .finally(() => {
        setBusyKey("");
      });
  }, [pending, load, onSessionExpired]);

  if (!loaded) return <p>Načítavam…</p>;
  if (error !== "") return <p role="alert">{error}</p>;
  if (list === null) return <p role="alert">Nedostupné tovary sa nepodarilo načítať.</p>;

  return (
    <section>
      <h2>Nedostupné tovary</h2>
      <p>Tovary, ktoré dodávateľ nemá, spárované s otvorenými objednávkami zákazníkov, ktorí na ne čakajú.</p>

      {list.bccMissing && (
        <p role="alert" data-testid="nedostupne-bcc-missing">
          ⚠️ Chýba adresa pre skrytú kópiu majiteľovi (NEDOSTUPNE_BCC_EMAIL) — automatizácia zatiaľ NEPOŠLE žiadny e-mail zákazníkovi.
        </p>
      )}
      {list.mailNotConfigured && (
        <p role="alert" data-testid="nedostupne-mail-not-configured">
          ⚠️ Odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST).
        </p>
      )}
      {actionError !== "" && <p role="alert">{actionError}</p>}

      {list.groups.length === 0 ? (
        <p data-testid="nedostupne-empty">Žiadny tovar momentálne nie je označený ako nedostupný.</p>
      ) : (
        <div className="nedostupne-groups" data-testid="nedostupne-groups">
          {list.groups.map((group) => (
            <div className="card" key={group.variantCode} data-testid={`nedostupne-group-${group.variantCode}`}>
              <div className="nedostupne-group-header">
                <span className="nedostupne-group-name">{itemLabel(group)}</span>
                <span className="pill off">{group.variantCode}</span>
              </div>

              {group.alternatives.length > 0 && (
                <ul className="nedostupne-alternatives" data-testid={`nedostupne-alternatives-${group.variantCode}`}>
                  {group.alternatives.map((a) => (
                    <li key={a.code}>
                      Náhrada:{" "}
                      <a href={a.url} target="_blank" rel="noreferrer">
                        {a.name}
                      </a>
                    </li>
                  ))}
                </ul>
              )}

              {group.orders.map((order) => {
                const rowBusy = busyKey.startsWith(`${order.orderCode}|${group.variantCode}|`);
                return (
                  <div className="nedostupne-order-row" key={order.orderCode} data-testid={`nedostupne-order-${order.orderCode}-${group.variantCode}`}>
                    <a href={order.adminLink} target="_blank" rel="noreferrer">
                      {order.orderCode}
                    </a>
                    <span>{order.customerName}</span>
                    <span>{order.email === "" ? "(bez e-mailu)" : order.email}</span>
                    <span>{order.quantity} ks</span>
                    {canControl && (
                      <div className="nedostupne-order-actions">
                        <button
                          type="button"
                          className="btn lg ghost"
                          disabled={rowBusy || order.nedostupneSent}
                          onClick={() => {
                            openPreview(order.orderCode, group.variantCode, "nedostupne");
                          }}
                          data-testid={`nedostupne-send-${order.orderCode}-${group.variantCode}`}
                        >
                          {order.nedostupneSent ? "✓ Odoslané" : "Nedostupné — náhľad"}
                        </button>
                        <button
                          type="button"
                          className="btn lg ghost"
                          disabled={rowBusy || order.alternativaSent}
                          onClick={() => {
                            openPreview(order.orderCode, group.variantCode, "alternativa");
                          }}
                          data-testid={`nedostupne-alt-send-${order.orderCode}-${group.variantCode}`}
                        >
                          {order.alternativaSent ? "✓ Odoslané" : "S náhradou — náhľad"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {pending !== null && (
        <div className="mail-preview" data-testid="nedostupne-preview">
          <h3>Náhľad e-mailu — povinné pred odoslaním</h3>
          <p>
            Komu: {pending.preview.recipient} — Predmet: {pending.preview.subject}
          </p>
          {/* `pending.preview.html` je appkou generovaný e-mail (`buildEmailForType`,
              `modules/nedostupne/logic.ts`) — meno zákazníka aj náhradné produkty sú
              tam už HTML-escapované, nikdy surový užívateľský vstup priamo tu. */}
          <div className="nedostupne-preview-body" dangerouslySetInnerHTML={{ __html: pending.preview.html }} />
          <div className="nedostupne-order-actions">
            <button
              type="button"
              className="btn lg good"
              disabled={busyKey !== ""}
              onClick={confirmSend}
              data-testid="nedostupne-confirm-send"
            >
              📧 Odoslať zákazníkovi
            </button>
            <button
              type="button"
              className="btn lg ghost"
              onClick={() => {
                setPending(null);
              }}
            >
              Zrušiť
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
