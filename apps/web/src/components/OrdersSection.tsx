import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import {
  fetchOpenOrders,
  fetchSupplierOrderMailPreview,
  OrdersUnauthorizedError,
  sendSupplierOrderMail,
  setSupplierEmail,
  updateOrderLineState,
  type OrderLine,
  type OrderMailPreview,
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

// Riadky, ktoré ešte treba objednať u dodávateľa (rovnaký zámer ako stará
// appka's `outstandingOf`/`!isHandled`, #31) — východiskový stav pred tým,
// než manažér čokoľvek ručne posunie ďalej.
const OUTSTANDING_STATE: OrderLine["state"] = "objednane";

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

  // #31: e-mailový kontakt dodávateľa (editovateľný priamo v zozname).
  const [editingEmailSupplier, setEditingEmailSupplier] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState("");

  // #31: náhľad + potvrdenie pred odoslaním objednávky mailom.
  const [previewSupplier, setPreviewSupplier] = useState<string | null>(null);
  const [preview, setPreview] = useState<OrderMailPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendResult, setSendResult] = useState<{ readonly supplier: string; readonly message: string } | null>(null);

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

  // #31: úprava e-mailu dodávateľa.
  const startEditEmail = useCallback((group: SupplierOpenOrders) => {
    setEditingEmailSupplier(group.supplier);
    setEmailDraft(group.email ?? "");
    setEmailError("");
  }, []);

  const cancelEditEmail = useCallback(() => {
    setEditingEmailSupplier(null);
    setEmailError("");
  }, []);

  const saveEmail = useCallback(
    (supplier: string) => {
      setEmailBusy(true);
      setEmailError("");
      const novyEmail = emailDraft.trim() === "" ? null : emailDraft.trim();
      setSupplierEmail(supplier, novyEmail)
        .then(() => {
          setSuppliers((current) =>
            current.map((group) => (group.supplier === supplier ? { ...group, email: novyEmail } : group)),
          );
          setEditingEmailSupplier(null);
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setEmailError(err instanceof Error ? err.message : "Nastavenie e-mailu sa nepodarilo.");
        })
        .finally(() => {
          setEmailBusy(false);
        });
    },
    [emailDraft, onSessionExpired],
  );

  // #31: náhľad pred odoslaním — server prepočíta predmet/telo/adresáta zo
  // skutočného aktuálneho stavu (nikdy sa nedôveruje tomu, čo je práve
  // zobrazené na klientovi).
  const openPreview = useCallback(
    (supplier: string) => {
      setPreviewSupplier(supplier);
      setPreview(null);
      setPreviewError("");
      setSendResult(null);
      fetchSupplierOrderMailPreview(supplier)
        .then((p) => {
          setPreview(p);
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setPreviewError(err instanceof Error ? err.message : "Náhľad mailu sa nepodarilo načítať.");
        });
    },
    [onSessionExpired],
  );

  const closePreview = useCallback(() => {
    setPreviewSupplier(null);
    setPreview(null);
    setPreviewError("");
  }, []);

  const confirmSend = useCallback(
    (supplier: string) => {
      setSendBusy(true);
      sendSupplierOrderMail(supplier)
        .then((result) => {
          setSendResult({
            supplier,
            message: result.ok
              ? `Objednávka bola odoslaná na ${preview?.to ?? "e-mail dodávateľa"}.`
              : (result.error ?? "Odoslanie sa nepodarilo."),
          });
          if (result.ok) {
            setPreviewSupplier(null);
            setPreview(null);
          }
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setSendResult({ supplier, message: err instanceof Error ? err.message : "Odoslanie sa nepodarilo." });
        })
        .finally(() => {
          setSendBusy(false);
        });
    },
    [onSessionExpired, preview],
  );

  const copyOrderToClipboard = useCallback(
    (supplier: string) => {
      fetchSupplierOrderMailPreview(supplier)
        .then(async (p) => {
          try {
            await navigator.clipboard.writeText(p.body);
            setSendResult({ supplier, message: "Text objednávky skopírovaný do schránky." });
          } catch {
            setSendResult({ supplier, message: "Kopírovanie do schránky sa nepodarilo." });
          }
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setSendResult({
            supplier,
            message: err instanceof Error ? err.message : "Text objednávky sa nepodarilo pripraviť.",
          });
        });
    },
    [onSessionExpired],
  );

  // `/api/orders/open` už zoraďuje riadky presne tak, ako majú byť zobrazené
  // (dodávateľ vzostupne, potom najnovšia objednávka prvá) — žiadne ďalšie
  // preskupovanie na klientovi.
  const totalLines = suppliers.reduce((sum, group) => sum + group.lines.length, 0);

  return (
    <section className="orders-section">
      {!loaded && <p>Načítavam otvorené objednávky…</p>}
      {error !== "" && <p role="alert">{error}</p>}
      {stateError !== "" && <p role="alert">{stateError}</p>}
      {loaded && totalLines === 0 && (
        <p className="empty" data-testid="orders-empty">Zatiaľ nie sú žiadne otvorené objednávky.</p>
      )}
      {suppliers.map((group) => (
        <div key={group.supplier} className="order-group" data-testid={`supplier-${group.supplier}`}>
          <div className="toorder-supplier">
            <span className="tosup-label">
              {group.supplier} — {group.lines.length} {group.lines.length === 1 ? "riadok" : "riadky"}
            </span>
            <div className="tosup-contact" data-testid={`supplier-contact-${group.supplier}`}>
              {editingEmailSupplier === group.supplier ? (
                <>
                  <input
                    className="tosup-emailinput"
                    aria-label={`E-mail dodávateľa ${group.supplier}`}
                    type="email"
                    value={emailDraft}
                    disabled={emailBusy}
                    onChange={(e) => {
                      setEmailDraft(e.target.value);
                    }}
                  />
                  <button type="button" className="btn sm good" disabled={emailBusy} onClick={() => { saveEmail(group.supplier); }}>
                    Uložiť
                  </button>
                  <button type="button" className="btn sm ghost" disabled={emailBusy} onClick={cancelEditEmail}>
                    Zrušiť
                  </button>
                  {emailError !== "" && <p role="alert">{emailError}</p>}
                </>
              ) : (
                <>
                  <span className="tosup-email">E-mail dodávateľa: {group.email ?? "nenastavený"}</span>
                  {canChangeState && (
                    <button type="button" className="btn sm ghost" onClick={() => { startEditEmail(group); }}>
                      Upraviť e-mail
                    </button>
                  )}
                </>
              )}
            </div>
            {canChangeState && (
              <div className="tosup-actions">
                <button type="button" className="btn sm ghost" onClick={() => { copyOrderToClipboard(group.supplier); }}>
                  📋 Kopírovať objednávku
                </button>
                <button
                  type="button"
                  className="btn sm good"
                  disabled={group.email === null || !group.lines.some((l) => l.state === OUTSTANDING_STATE)}
                  title={
                    group.email === null
                      ? "Pre odoslanie mailom treba najprv nastaviť e-mail dodávateľa."
                      : undefined
                  }
                  onClick={() => { openPreview(group.supplier); }}
                >
                  ✉️ Poslať objednávku e-mailom
                </button>
              </div>
            )}
          </div>
          {canChangeState && group.email === null && (
            <p className="reenote">Pre odoslanie mailom treba najprv nastaviť e-mail dodávateľa.</p>
          )}
          {sendResult?.supplier === group.supplier && <p role="status">{sendResult.message}</p>}
          {previewSupplier === group.supplier && (
            <div className="mail-preview" data-testid={`mail-preview-${group.supplier}`}>
              {previewError !== "" && <p role="alert">{previewError}</p>}
              {preview !== null && (
                <>
                  <p>Komu: {preview.to ?? "—"}</p>
                  <p>Predmet: {preview.subject}</p>
                  <pre>{preview.body}</pre>
                  <button type="button" className="btn sm good" disabled={sendBusy} onClick={() => { confirmSend(group.supplier); }}>
                    Odoslať
                  </button>
                  <button type="button" className="btn sm ghost" disabled={sendBusy} onClick={closePreview}>
                    Zrušiť
                  </button>
                </>
              )}
            </div>
          )}
          <table className="orders-table">
            <thead>
              <tr>
                <th>Objednávka</th>
                <th>Zákazník</th>
                <th>Kód</th>
                <th>Produkt</th>
                <th>Veľkosť</th>
                <th>Množstvo</th>
                <th>Dodávateľ</th>
                <th>Stav</th>
                <th>Objednané</th>
                <th>Komentár</th>
              </tr>
            </thead>
            <tbody>
              {group.lines.map((line) => (
                <tr
                  key={line.lineId}
                  className={"order-row state-" + line.state}
                  data-testid={`order-line-${line.lineId}`}
                >
                  <td>{line.externalOrderId}</td>
                  <td>{line.customerName}</td>
                  <td>{line.variantCode}</td>
                  <td>{line.variantName}</td>
                  <td>{line.sizeLabel ?? "—"}</td>
                  <td className="ord-qty">{line.quantity} ks</td>
                  <td className="ord-supplier-cell" data-testid={`supplier-link-${line.lineId}`}>
                    {line.supplierUrl !== null ? (
                      <a
                        href={line.supplierUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="ord-supplier-link"
                        aria-label={`Odkaz na dodávateľa — ${line.variantName}`}
                      >
                        Odkaz na dodávateľa
                      </a>
                    ) : line.supplierNote !== null ? (
                      <span className="ord-supplier-note" title={line.supplierNote}>
                        {line.supplierNote}
                      </span>
                    ) : line.externalCode === null ? (
                      "—"
                    ) : null}
                    {line.externalCode !== null && <div className="ord-supplier-code">kód {line.externalCode}</div>}
                  </td>
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
                        className="ord-state-select"
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
