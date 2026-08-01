import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { isLineResolved } from "../ordersSummary.js";
import { useSupplierMailActions } from "../useSupplierMailActions.js";
import { OrderOpenStatusesPanel } from "./OrderOpenStatusesPanel.js";
import { OrdersToolbar } from "./OrdersToolbar.js";
import { SupplierOrderGroup } from "./SupplierOrderGroup.js";
import {
  assignOrderLineSupplier as assignOrderLineSupplierApi,
  fetchOpenOrders,
  NEZNAMY_DODAVATEL,
  OrdersUnauthorizedError,
  setProductSupplierLink,
  setSupplierEmail,
  setSupplierLinesOrdered,
  updateOrderComment,
  updateOrderLineOrdered,
  updateOrderLineState,
  type OrderLine,
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

  // #31: náhľad + potvrdenie pred odoslaním objednávky mailom — vyňaté do
  // vlastného hooku (issue 64), aby sa v tomto súbore uvoľnilo miesto pod
  // eslint `max-lines: 400` pre novú funkciu nižšie (poznámka k objednávke),
  // BEZ zmeny správania (`useSupplierMailActions.ts`).
  const {
    previewSupplier,
    preview,
    previewError,
    sendBusy,
    sendResult,
    openPreview,
    closePreview,
    confirmSend,
    copyOrderToClipboard,
  } = useSupplierMailActions(onSessionExpired);

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

  // issue 63: ručné priradenie dodávateľa riadku bez dodávateľa. PLNÝ refetch
  // po úspechu (nie lokálna oprava) — priradenie mení SKUPINU riadku
  // (`ordersApi.ts`'s `assignOrderLineSupplier` komentár vysvetľuje prečo).
  const [busySupplierLineId, setBusySupplierLineId] = useState<string | null>(null);

  const assignSupplier = useCallback(
    (lineId: string, supplier: string) => {
      setStateError("");
      setBusySupplierLineId(lineId);
      assignOrderLineSupplierApi(lineId, supplier)
        .then(() => {
          load();
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setStateError(err instanceof Error ? err.message : "Priradenie dodávateľa sa nepodarilo.");
          // issue 89 (review PR 87): predtým sa `load()` volalo LEN v úspešnej
          // vetve vyššie — pri zamietnutí (napr. server vráti 409, lebo
          // produkt medzitým dostal dodávateľa v katalógu inou cestou, súbeh s
          // importom alebo dlho otvorená stránka iného manažéra) zoznam
          // zostal STARÝ a vstupné pole na priradenie by tak ostalo viditeľné
          // navždy — manažér by mohol skúšať donekonečna. `load()` mení len
          // `suppliers`/`loaded`/`error`, nikdy `stateError` (nezávislý stav
          // vyššie), takže táto hláška ostáva viditeľná aj po refetchi.
          load();
        })
        .finally(() => {
          setBusySupplierLineId(null);
        });
    },
    [load, onSessionExpired],
  );

  // issue 121: manuálny odkaz na dodávateľa — PLNÝ refetch po úspechu (rovnaký
  // dôvod ako `assignSupplier` vyššie: zmena platí pre celý PRODUKT, teda aj
  // pre súrodenecké veľkosti toho istého riadku).
  const [busySupplierLinkLineId, setBusySupplierLinkLineId] = useState<string | null>(null);

  const setSupplierLink = useCallback(
    (lineId: string, url: string) => {
      setStateError("");
      setBusySupplierLinkLineId(lineId);
      setProductSupplierLink(lineId, url)
        .then(() => {
          load();
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setStateError(err instanceof Error ? err.message : "Uloženie odkazu na dodávateľa sa nepodarilo.");
        })
        .finally(() => {
          setBusySupplierLinkLineId(null);
        });
    },
    [load, onSessionExpired],
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

  // issue 64: manažérova voľná poznámka k CELEJ objednávke — NEZÁVISLÉ od
  // riadku (na rozdiel od `changeState`/`changeOrdered` vyššie, kľúčované
  // `orderId`, nie `lineId`). Po úspechu sa lokálne aktualizujú VŠETKY
  // riadky s rovnakým `orderId` naprieč VŠETKÝMI skupinami dodávateľov (na
  // rozdiel od `toggleGroupOrdered`, ktoré mutuje len JEDNU skupinu — jedna
  // objednávka môže mať riadky u viacerých dodávateľov naraz).
  const [busyCommentOrderId, setBusyCommentOrderId] = useState<string | null>(null);

  const changeComment = useCallback(
    (orderId: string, comment: string | null) => {
      setStateError("");
      setBusyCommentOrderId(orderId);
      updateOrderComment(orderId, comment)
        .then(() => {
          setSuppliers((current) =>
            current.map((group) => ({
              ...group,
              lines: group.lines.map((line) => (line.orderId === orderId ? { ...line, comment } : line)),
            })),
          );
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setStateError(err instanceof Error ? err.message : "Uloženie poznámky sa nepodarilo.");
        })
        .finally(() => {
          setBusyCommentOrderId(null);
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

  // issue 63: UŽ známe pravopisy dodávateľov (bez zástupného
  // "(bez dodávateľa)") pre `<datalist>` našepkávanie — z toho, čo appka UŽ
  // má načítané (`suppliers`), žiadna nová GET trasa netreba. `Set` odstráni
  // prípadné duplicity (viac skupín s tým istým zobrazovaným pravopisom by
  // dnes nemalo nastať, ale je to lacná poistka).
  const knownSuppliers = [...new Set(suppliers.map((g) => g.supplier).filter((s) => s !== NEZNAMY_DODAVATEL))].sort();

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
      {/* issue 63: JEDEN zdieľaný datalist pre všetky priraďovacie polia
          (`OrderLineRow.tsx`'s `list="known-suppliers"`) — voľba dodávateľa
          sa nemení podľa skupiny/riadku, takže stačí jeden globálny zoznam. */}
      <datalist id="known-suppliers">
        {knownSuppliers.map((supplier) => (
          <option key={supplier} value={supplier} />
        ))}
      </datalist>
      {filteredGroups.map((group) => (
        <SupplierOrderGroup
          key={group.supplier}
          group={group}
          hideResolved={hideResolved}
          canChangeState={canChangeState}
          busyLineId={busyLineId}
          busyOrderedLineId={busyOrderedLineId}
          busyOrderedSupplier={busyOrderedSupplier}
          busySupplierLineId={busySupplierLineId}
          busySupplierLinkLineId={busySupplierLinkLineId}
          busyCommentOrderId={busyCommentOrderId}
          onChangeState={changeState}
          onChangeOrdered={changeOrdered}
          onAssignSupplier={assignSupplier}
          onSetSupplierLink={setSupplierLink}
          onChangeComment={changeComment}
          editingEmailSupplier={editingEmailSupplier}
          emailDraft={emailDraft}
          emailBusy={emailBusy}
          emailError={emailError}
          onEmailDraftChange={setEmailDraft}
          onStartEditEmail={startEditEmail}
          onSaveEmail={saveEmail}
          onCancelEditEmail={cancelEditEmail}
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
      ))}
    </section>
  );
}
