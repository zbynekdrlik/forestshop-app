import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { computeVariantTotals, isLineResolved } from "../ordersSummary.js";
import { OrderLineRow } from "./OrderLineRow.js";
import { OrderOpenStatusesPanel } from "./OrderOpenStatusesPanel.js";
import { OrdersToolbar } from "./OrdersToolbar.js";
import { SupplierActionsPanel } from "./SupplierActionsPanel.js";
import {
  fetchOpenOrders,
  fetchSupplierOrderMailPreview,
  OrdersUnauthorizedError,
  sendSupplierOrderMail,
  setSupplierEmail,
  setSupplierLinesOrdered,
  updateOrderLineOrdered,
  updateOrderLineState,
  type OrderLine,
  type OrderMailPreview,
  type SupplierOpenOrders,
} from "../ordersApi.js";

// Rovnaké dve role, ktoré server vyžaduje pre
// `POST /api/orders/lines/:lineId/state` (`requireRole("admin", "manazer")`,
// `orders-routes.ts`) — server ostáva skutočnou bránou, toto len skrýva
// ovládací prvok pre role, ktoré by aj tak dostali 403 (rovnaký vzor ako
// `CatalogPage`'s `IMPORT_ROLES`/`SchedulerSection`'s `SCHEDULER_ROLES`).
const CAN_CHANGE_STATE_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

// issue 61: kľúč pre prepínač "skryť vybavené riadky" — jediný stav, ktorý
// má prežiť obnovenie stránky (issue to pýta výslovne LEN preň, výber
// dodávateľa/chipu ostáva zámerne len klientský stav bez perzistencie).
const HIDE_RESOLVED_STORAGE_KEY = "forestshop.orders.hideResolved";

function readHideResolvedPreference(): boolean {
  try {
    return window.localStorage.getItem(HIDE_RESOLVED_STORAGE_KEY) === "1";
  } catch {
    // localStorage nedostupné (napr. prehliadač so zakázaným úložiskom) —
    // prepínač jednoducho nezačne predvyplnený, nič nespadne.
    return false;
  }
}

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

  // issue 61: vybraný dodávateľ (chip) — `null` = "Všetci". Prepínač "skryť
  // vybavené" sa naopak číta raz pri mount-e priamo z localStorage (lazy
  // init), aby appka po reloade neblikla najprv nefiltrovaný zoznam.
  const [selectedSupplier, setSelectedSupplier] = useState<string | null>(null);
  const [hideResolved, setHideResolved] = useState<boolean>(readHideResolvedPreference);

  const toggleHideResolved = useCallback(() => {
    setHideResolved((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(HIDE_RESOLVED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // localStorage nedostupné — voľba ostáva platná len pre túto reláciu.
      }
      return next;
    });
  }, []);

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

  // issue 60: odškrtávacie políčko "objednané u dodávateľa" — per riadok aj
  // hromadne pre celú skupinu dodávateľa. NEZÁVISLÉ od `changeState` vyššie.
  const [busyOrderedLineId, setBusyOrderedLineId] = useState<string | null>(null);
  const [busyOrderedSupplier, setBusyOrderedSupplier] = useState<string | null>(null);

  const changeOrdered = useCallback(
    (lineId: string, ordered: boolean) => {
      setStateError("");
      setBusyOrderedLineId(lineId);
      updateOrderLineOrdered(lineId, ordered)
        .then(() => {
          setSuppliers((current) =>
            current.map((group) => ({
              ...group,
              lines: group.lines.map((line) => (line.lineId === lineId ? { ...line, ordered } : line)),
            })),
          );
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setStateError(err instanceof Error ? err.message : "Zmena príznaku objednané sa nepodarila.");
        })
        .finally(() => {
          setBusyOrderedLineId(null);
        });
    },
    [onSessionExpired],
  );

  // Hromadné označenie/zrušenie CELEJ skupiny dodávateľa naraz (stará appka's
  // `markGroupOrdered` — jedno tlačidlo, ktoré prepína smer podľa toho, či je
  // skupina UŽ celá objednaná, `webreview/static/app.js`'s `allOrdered`).
  const toggleGroupOrdered = useCallback(
    (supplier: string, ordered: boolean) => {
      setStateError("");
      setBusyOrderedSupplier(supplier);
      setSupplierLinesOrdered(supplier, ordered)
        .then(() => {
          setSuppliers((current) =>
            current.map((group) =>
              group.supplier === supplier
                ? { ...group, lines: group.lines.map((line) => ({ ...line, ordered })) }
                : group,
            ),
          );
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setStateError(err instanceof Error ? err.message : "Hromadné označenie skupiny sa nepodarilo.");
        })
        .finally(() => {
          setBusyOrderedSupplier(null);
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

  // issue 61: dodávatelia zúžení podľa vybraného chipu — hromadné akcie
  // (`SupplierActionsPanel`) dostávajú vždy PLNÉ `group.lines` (nefiltrované
  // podľa `hideResolved`), lebo server aj tak mutuje celú skupinu naraz;
  // filtrovaný pohľad je len na to, ktoré RIADKY tabuľky sa vykreslia.
  const filteredGroups = suppliers.filter(
    (group) => selectedSupplier === null || group.supplier === selectedSupplier,
  );
  const visibleLinesCount = filteredGroups.reduce(
    (sum, group) => sum + (hideResolved ? group.lines.filter((line) => !isLineResolved(line)).length : group.lines.length),
    0,
  );

  return (
    <section className="orders-section">
      {!loaded && <p>Načítavam otvorené objednávky…</p>}
      {error !== "" && <p role="alert">{error}</p>}
      {stateError !== "" && <p role="alert">{stateError}</p>}
      {canChangeState && <OrderOpenStatusesPanel onSessionExpired={onSessionExpired} onSaved={load} />}
      {loaded && totalLines === 0 && (
        <p className="empty" data-testid="orders-empty">Zatiaľ nie sú žiadne otvorené objednávky.</p>
      )}
      {loaded && totalLines > 0 && (
        <OrdersToolbar
          suppliers={suppliers}
          selectedSupplier={selectedSupplier}
          onSelectSupplier={setSelectedSupplier}
          hideResolved={hideResolved}
          onToggleHideResolved={toggleHideResolved}
        />
      )}
      {loaded && totalLines > 0 && hideResolved && visibleLinesCount === 0 && (
        <p className="empty" data-testid="orders-hidden-empty">
          {selectedSupplier === null
            ? "Všetko vybavené — vybavené riadky sú skryté."
            : "Tento dodávateľ je vybavený — vybavené riadky sú skryté."}
        </p>
      )}
      {filteredGroups.map((group) => {
        const visibleLines = hideResolved ? group.lines.filter((line) => !isLineResolved(line)) : group.lines;
        if (visibleLines.length === 0) return null;
        // issue 62: súčty sa počítajú nad CELOU (nefiltrovanou) skupinou
        // dodávateľa, nikdy nad `visibleLines` — chip nesmie zmiznúť/zmeniť
        // hodnotu len preto, že prepínač "skryť vybavené" skryl sesterský
        // riadok toho istého produktu (`.claude/rules/orders.md`'s zámer
        // pre `outstandingOf` v starej appke).
        const variantTotals = computeVariantTotals(group.lines);
        return (
          <div key={group.supplier} className="order-group" data-testid={`supplier-${group.supplier}`}>
            <SupplierActionsPanel
              group={group}
              canChangeState={canChangeState}
              editingEmailSupplier={editingEmailSupplier}
              emailDraft={emailDraft}
              emailBusy={emailBusy}
              emailError={emailError}
              onEmailDraftChange={setEmailDraft}
              onStartEditEmail={startEditEmail}
              onSaveEmail={saveEmail}
              onCancelEditEmail={cancelEditEmail}
              busyOrderedSupplier={busyOrderedSupplier}
              busyOrderedLineId={busyOrderedLineId}
              onToggleGroupOrdered={toggleGroupOrdered}
              onCopyOrderToClipboard={copyOrderToClipboard}
              previewSupplier={previewSupplier}
              preview={preview}
              previewError={previewError}
              sendBusy={sendBusy}
              sendResult={sendResult}
              onOpenPreview={openPreview}
              onClosePreview={closePreview}
              onConfirmSend={confirmSend}
            />
            <table className="orders-table">
              <thead>
                <tr>
                  {/* issue 60: odškrtávacie políčko — JEDINÉ miesto na obrazovke,
                      ktoré sa smie volať "Objednané" (viď `STATE_LABELS`
                      a stĺpec dátumu nižšie, obe premenované, aby nekolidovali). */}
                  <th>Objednané</th>
                  <th>Objednávka</th>
                  <th>Zákazník</th>
                  <th>Kód</th>
                  <th>Produkt</th>
                  <th>Veľkosť</th>
                  <th>Množstvo</th>
                  <th>Dodávateľ</th>
                  <th>Stav</th>
                  <th>Dátum objednávky</th>
                  <th>Komentár</th>
                </tr>
              </thead>
              <tbody>
                {visibleLines.map((line) => (
                  <OrderLineRow
                    key={line.lineId}
                    line={line}
                    canChangeState={canChangeState}
                    busyLineId={busyLineId}
                    busyOrderedLineId={busyOrderedLineId}
                    // Review of PR 75, finding 6: kým hromadná akcia pre TOHTO
                    // dodávateľa beží, žiadny riadok jeho skupiny sa nesmie dať
                    // meniť per-riadkovo naraz.
                    supplierBusy={busyOrderedSupplier === group.supplier}
                    variantTotal={variantTotals.get(line.variantCode)}
                    onChangeState={changeState}
                    onChangeOrdered={changeOrdered}
                  />
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}
