import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { Me } from "../api.js";
import {
  addReplacementLink,
  fetchNedostupneList,
  fetchNedostupnePreview,
  NedostupneUnauthorizedError,
  removeReplacementLink,
  sendNedostupneEmail,
  type NedostupneEmailType,
  type NedostupneGroup,
  type NedostupneList,
  type NedostupnePreview,
} from "../nedostupneApi.js";
import { MailPreviewDialog } from "./MailPreviewDialog.js";

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
  // issue 191: spúšťacie tlačidlo si pamätáme už pri kliknutí — kým sa náhľad
  // načítava, je `disabled` a prehliadač z neho fokus zhodí, takže po zavretí
  // dialógu by sa nemal kam vrátiť (naživo overené na produkcii).
  const triggerRef = useRef<HTMLElement | null>(null);
  const canControl = CONTROL_ROLES.has(role);
  // issue 238: majiteľove RUČNE vložené odkazy náhrad — draft rozpísaného
  // odkazu je per-GROUP (variantCode), nie globálny; `busyKey` vyššie je
  // vyhradený pre náhľad/odoslanie, preto má tento blok VLASTNÝ busy stav
  // (rôzne akcie na tej istej karte sa nesmú vzájomne blokovať).
  const [linkDrafts, setLinkDrafts] = useState<Record<string, string>>({});
  const [linkBusy, setLinkBusy] = useState("");

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
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
    sendNedostupneEmail(pending.orderCode, pending.variantCode, pending.emailType, pending.preview.previewToken)
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

  // issue 238: pridanie majiteľovho ručného odkazu náhrady — po úspechu sa
  // draft vyprázdni a zoznam sa znova načíta (server je zdroj pravdy, žiadny
  // optimistický lokálny insert).
  const addLink = useCallback(
    (variantCode: string) => {
      const url = (linkDrafts[variantCode] ?? "").trim();
      if (url === "") return;
      setActionError("");
      setLinkBusy(variantCode);
      addReplacementLink(variantCode, url)
        .then(() => {
          setLinkDrafts((drafts) => ({ ...drafts, [variantCode]: "" }));
          load();
        })
        .catch((err: unknown) => {
          if (err instanceof NedostupneUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Odkaz sa nepodarilo pridať.");
        })
        .finally(() => {
          setLinkBusy("");
        });
    },
    [linkDrafts, load, onSessionExpired],
  );

  const removeLink = useCallback(
    (id: string) => {
      setActionError("");
      setLinkBusy(id);
      removeReplacementLink(id)
        .then(load)
        .catch((err: unknown) => {
          if (err instanceof NedostupneUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Odkaz sa nepodarilo zmazať.");
        })
        .finally(() => {
          setLinkBusy("");
        });
    },
    [load, onSessionExpired],
  );

  if (!loaded) return <p>Načítavam…</p>;
  if (error !== "") return <p role="alert">{error}</p>;
  if (list === null) return <p role="alert">Nedostupné tovary sa nepodarilo načítať.</p>;

  return (
    <section>
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
                {/* issue 238: preklik na náš e-shop — `null` = adresu vo
                    feede nemáme, meno ostáva NEAKTÍVNY plain text (nikdy
                    vyhľadávací fallback, majiteľova výslovná podmienka). */}
                <span className="nedostupne-group-name">
                  {group.ourProductUrl !== null ? (
                    <a href={group.ourProductUrl} target="_blank" rel="noreferrer" data-testid={`nedostupne-shop-link-${group.variantCode}`}>
                      {itemLabel(group)}
                    </a>
                  ) : (
                    itemLabel(group)
                  )}
                </span>
                {/* issue 238: preklik na dodávateľa — rovnaká funkcia ako
                    "Na objednanie" (`resolveEffectiveSupplierLink`). */}
                {group.supplierUrl !== null ? (
                  <a className="pill off" href={group.supplierUrl} target="_blank" rel="noreferrer" data-testid={`nedostupne-supplier-link-${group.variantCode}`}>
                    {group.variantCode}
                  </a>
                ) : (
                  <span className="pill off">{group.variantCode}</span>
                )}
              </div>

              {/* issue 238: majiteľove RUČNE vložené odkazy náhrad — nahrádza
                  pôvodný automatický "Náhrada:" zoznam z `product.relatedCodes`
                  (majiteľ ho zamietol ako "súvisiace produkty, nie náhrady").
                  Zoznam je viditeľný VŠETKÝM (rovnaká úroveň ako čítanie
                  zvyšku karty); pridanie/zmazanie je gated na `canControl`. */}
              {group.replacementLinks.length > 0 && (
                <ul className="nedostupne-replacement-links" data-testid={`nedostupne-replacement-links-${group.variantCode}`}>
                  {group.replacementLinks.map((link) => (
                    <li key={link.id} data-testid={`nedostupne-replacement-link-${link.id}`}>
                      <a href={link.url} target="_blank" rel="noreferrer">
                        {link.url}
                      </a>
                      {canControl && (
                        <button
                          type="button"
                          className="btn sm ghost"
                          disabled={linkBusy === link.id}
                          onClick={() => {
                            removeLink(link.id);
                          }}
                          data-testid={`nedostupne-replacement-link-remove-${link.id}`}
                        >
                          ✕ zmazať
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {canControl && (
                <div className="nedostupne-replacement-link-add">
                  <input
                    type="url"
                    placeholder="Odkaz na náhradný produkt (https://…)"
                    value={linkDrafts[group.variantCode] ?? ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      setLinkDrafts((drafts) => ({ ...drafts, [group.variantCode]: value }));
                    }}
                    aria-label={`Pridať odkaz náhrady pre ${itemLabel(group)}`}
                    data-testid={`nedostupne-replacement-link-input-${group.variantCode}`}
                  />
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={linkBusy === group.variantCode || (linkDrafts[group.variantCode] ?? "").trim() === ""}
                    onClick={() => {
                      addLink(group.variantCode);
                    }}
                    data-testid={`nedostupne-replacement-link-add-${group.variantCode}`}
                  >
                    + Pridať odkaz
                  </button>
                </div>
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

      {/* issue 191: náhľad je dialóg cez obrazovku, nie rozbalený blok na
          spodku stránky. Jednorazový `previewToken` z `/preview` ide ďalej
          nezmenený do `/send` (`.claude/rules/nedostupne.md`) — dialóg mení
          len to, KDE sa náhľad ukáže, nikdy nie to, že bez potvrdenia
          človekom e-mail neodíde. */}
      {pending !== null && (
        <MailPreviewDialog
          testId="nedostupne-preview"
          title="Náhľad e-mailu — povinné pred odoslaním"
          recipient={pending.preview.recipient}
          subject={pending.preview.subject}
          html={pending.preview.html}
          confirmLabel="📧 Odoslať zákazníkovi"
          confirmDisabled={busyKey !== ""}
          onConfirm={confirmSend}
          returnFocusRef={triggerRef}
          onClose={() => {
            setPending(null);
          }}
        />
      )}
    </section>
  );
}
