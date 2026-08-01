import { useCallback, useContext, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import {
  persistHideResolvedPreference,
  persistSelectedSupplier,
  readHideResolvedPreference,
  readSelectedSupplierPreference,
} from "../ordersDisplayPreferences.js";
import { OrdersRemainingCountContext } from "../ordersRemainingCountContext.js";
import { isLineHiddenByFilter, summarizeOrderLines } from "../ordersSummary.js";
import { clearWriteFailure, lineWhere, orderWhere, upsertWriteFailure, type OrderWriteFailure } from "../ordersWriteFailures.js";
import { useDirtyEditorLineIds } from "../useDirtyEditorLineIds.js";
import { useSupplierEmailEditing } from "../useSupplierEmailEditing.js";
import { useSupplierMailActions } from "../useSupplierMailActions.js";
import { OrderOpenStatusesPanel } from "./OrderOpenStatusesPanel.js";
import { OrdersToolbar } from "./OrdersToolbar.js";
import { OrderWriteFailuresBanner } from "./OrderWriteFailuresBanner.js";
import { SupplierOrderGroup } from "./SupplierOrderGroup.js";
import {
  assignOrderLineSupplier as assignOrderLineSupplierApi,
  fetchOpenOrders,
  NEZNAMY_DODAVATEL,
  OrdersUnauthorizedError,
  setProductSupplierLink,
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
  // issue 66: kumulatívny zoznam zlyhaní zápisu (nahrádza pôvodný jediný
  // `stateError` string, ktorý každé ĎALŠIE zlyhanie prepísalo — pozri
  // `ordersWriteFailures.ts`'s modulový komentár + komentár na tickete).
  const [writeFailures, setWriteFailures] = useState<readonly OrderWriteFailure[]>([]);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const canChangeState = CAN_CHANGE_STATE_ROLES.has(role);

  // issue 61/148: vybraný dodávateľ (chip) aj prepínač "skryť vybavené" sa
  // OBA čítajú raz pri mount-e priamo z localStorage (lazy init), aby appka
  // po reloade neblikla najprv nefiltrovaný/nezúžený zoznam.
  const [selectedSupplier, setSelectedSupplierState] = useState<string | null>(readSelectedSupplierPreference);
  const [hideResolved, setHideResolved] = useState<boolean>(readHideResolvedPreference);

  // issue 148: jediné miesto, ktoré mení `selectedSupplier` — VŽDY aj
  // persistuje, takže žiadne volajúce miesto (manuálny klik na chip AJ
  // automatický fallback nižšie) nemôže zabudnúť na jednu z dvoch strán.
  const selectSupplier = useCallback((next: string | null) => {
    setSelectedSupplierState(next);
    persistSelectedSupplier(next);
  }, []);

  const toggleHideResolved = useCallback(() => {
    setHideResolved((current) => {
      const next = !current;
      persistHideResolvedPreference(next);
      return next;
    });
  }, []);

  // #31: e-mailový kontakt dodávateľa (editovateľný priamo v zozname) —
  // vyňaté do vlastného hooku (issue 66), pozri `useSupplierEmailEditing.ts`.
  const {
    editingEmailSupplier,
    emailDraft,
    emailBusy,
    emailError,
    onEmailDraftChange: setEmailDraft,
    onStartEditEmail: startEditEmail,
    onSaveEmail: saveEmail,
    onCancelEditEmail: cancelEditEmail,
  } = useSupplierEmailEditing(setSuppliers, onSessionExpired);

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

  // issue 147: publikuje počet NEVYBAVENÝCH riadkov (naprieč VŠETKÝMI
  // dodávateľmi) do ľavého menu cez `OrdersRemainingCountContext` — po KAŽDEJ
  // zmene `suppliers`, takže odznak je vždy aktuálny. Pred prvým úspešným
  // načítaním sa nevolá vôbec — Sidebar dovtedy odznak nevykreslí.
  const { setCount: setOrdersRemainingCount } = useContext(OrdersRemainingCountContext);
  useEffect(() => {
    if (!loaded) return;
    const allLines = suppliers.flatMap((group) => group.lines);
    setOrdersRemainingCount(summarizeOrderLines(allLines).remaining);
  }, [loaded, suppliers, setOrdersRemainingCount]);

  // issue 148 — priamy náprotivok starej appky's fallback (`app.js:2677-2680`):
  // keď je dodávateľ vybraný z PREDCHÁDZAJÚCEJ relácie/dňa (localStorage) a
  // medzi PRÁVE načítanými skupinami už vôbec nefiguruje, výber spadne späť
  // na "Všetci" — namiesto toho, aby zobrazil prázdny zoznam s aktívnym
  // chipom, ktorý nikde nie je. `suppliers.length === 0` sa zámerne
  // VYNECHÁVA (rovnako ako stará appka) — prechodné zlyhanie fetchu nesmie
  // zahodiť platný výber.
  useEffect(() => {
    if (!loaded || selectedSupplier === null || suppliers.length === 0) return;
    if (!suppliers.some((group) => group.supplier === selectedSupplier)) {
      selectSupplier(null);
    }
  }, [loaded, suppliers, selectedSupplier, selectSupplier]);

  const changeState = useCallback(
    (lineId: string, newState: OrderLine["state"]) => {
      const failureId = `state:${lineId}`;
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
          setWriteFailures((current) => clearWriteFailure(current, failureId));
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setWriteFailures((current) =>
            upsertWriteFailure(current, {
              id: failureId,
              what: "Zmena stavu",
              where: lineWhere(suppliers, lineId),
              detail: err instanceof Error ? err.message : "Zmena stavu sa nepodarila.",
            }),
          );
        })
        .finally(() => {
          setBusyLineId(null);
        });
    },
    [onSessionExpired, suppliers],
  );

  // issue 60: odškrtávacie políčko "objednané u dodávateľa" — per riadok aj
  // hromadne pre celú skupinu dodávateľa. NEZÁVISLÉ od `changeState` vyššie.
  const [busyOrderedLineId, setBusyOrderedLineId] = useState<string | null>(null);
  const [busyOrderedSupplier, setBusyOrderedSupplier] = useState<string | null>(null);

  const changeOrdered = useCallback(
    (lineId: string, ordered: boolean) => {
      const failureId = `ordered:${lineId}`;
      setBusyOrderedLineId(lineId);
      updateOrderLineOrdered(lineId, ordered)
        .then(() => {
          setSuppliers((current) =>
            current.map((group) => ({
              ...group,
              lines: group.lines.map((line) => (line.lineId === lineId ? { ...line, ordered } : line)),
            })),
          );
          setWriteFailures((current) => clearWriteFailure(current, failureId));
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setWriteFailures((current) =>
            upsertWriteFailure(current, {
              id: failureId,
              what: "Príznak objednané",
              where: lineWhere(suppliers, lineId),
              detail: err instanceof Error ? err.message : "Zmena príznaku objednané sa nepodarila.",
            }),
          );
        })
        .finally(() => {
          setBusyOrderedLineId(null);
        });
    },
    [onSessionExpired, suppliers],
  );

  // issue 63: ručné priradenie dodávateľa riadku bez dodávateľa. PLNÝ refetch
  // po úspechu (nie lokálna oprava) — priradenie mení SKUPINU riadku
  // (`ordersApi.ts`'s `assignOrderLineSupplier` komentár vysvetľuje prečo).
  const [busySupplierLineId, setBusySupplierLineId] = useState<string | null>(null);

  const assignSupplier = useCallback(
    (lineId: string, supplier: string) => {
      const failureId = `supplier:${lineId}`;
      const where = lineWhere(suppliers, lineId);
      setBusySupplierLineId(lineId);
      assignOrderLineSupplierApi(lineId, supplier)
        .then(() => {
          setWriteFailures((current) => clearWriteFailure(current, failureId));
          load();
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setWriteFailures((current) =>
            upsertWriteFailure(current, {
              id: failureId,
              what: "Priradenie dodávateľa",
              where,
              detail: err instanceof Error ? err.message : "Priradenie dodávateľa sa nepodarilo.",
            }),
          );
          // issue 89 (review PR 87): predtým sa `load()` volalo LEN v úspešnej
          // vetve vyššie — pri zamietnutí (napr. server vráti 409, lebo
          // produkt medzitým dostal dodávateľa v katalógu inou cestou, súbeh s
          // importom alebo dlho otvorená stránka iného manažéra) zoznam
          // zostal STARÝ a vstupné pole na priradenie by tak ostalo viditeľné
          // navždy — manažér by mohol skúšať donekonečna. `load()` mení len
          // `suppliers`/`loaded`/`error`, nikdy `writeFailures` (nezávislý stav
          // vyššie), takže táto hláška ostáva viditeľná aj po refetchi.
          load();
        })
        .finally(() => {
          setBusySupplierLineId(null);
        });
    },
    [load, onSessionExpired, suppliers],
  );

  // issue 121: manuálny odkaz na dodávateľa — PLNÝ refetch po úspechu (rovnaký
  // dôvod ako `assignSupplier` vyššie: zmena platí pre celý PRODUKT, teda aj
  // pre súrodenecké veľkosti toho istého riadku).
  const [busySupplierLinkLineId, setBusySupplierLinkLineId] = useState<string | null>(null);

  const setSupplierLink = useCallback(
    (lineId: string, url: string) => {
      const failureId = `supplierLink:${lineId}`;
      const where = lineWhere(suppliers, lineId);
      setBusySupplierLinkLineId(lineId);
      setProductSupplierLink(lineId, url)
        .then(() => {
          setWriteFailures((current) => clearWriteFailure(current, failureId));
          load();
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setWriteFailures((current) =>
            upsertWriteFailure(current, {
              id: failureId,
              what: "Odkaz na dodávateľa",
              where,
              detail: err instanceof Error ? err.message : "Uloženie odkazu na dodávateľa sa nepodarilo.",
            }),
          );
        })
        .finally(() => {
          setBusySupplierLinkLineId(null);
        });
    },
    [load, onSessionExpired, suppliers],
  );

  // Hromadné označenie/zrušenie CELEJ skupiny dodávateľa naraz (stará appka's
  // `markGroupOrdered` — jedno tlačidlo, ktoré prepína smer podľa toho, či je
  // skupina UŽ celá objednaná, `webreview/static/app.js`'s `allOrdered`).
  const toggleGroupOrdered = useCallback(
    (supplier: string, ordered: boolean) => {
      const failureId = `groupOrdered:${supplier}`;
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
          setWriteFailures((current) => clearWriteFailure(current, failureId));
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setWriteFailures((current) =>
            upsertWriteFailure(current, {
              id: failureId,
              what: "Hromadné označenie skupiny",
              where: `dodávateľ ${supplier}`,
              detail: err instanceof Error ? err.message : "Hromadné označenie skupiny sa nepodarilo.",
            }),
          );
        })
        .finally(() => {
          setBusyOrderedSupplier(null);
        });
    },
    [onSessionExpired],
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
      const failureId = `comment:${orderId}`;
      setBusyCommentOrderId(orderId);
      updateOrderComment(orderId, comment)
        .then(() => {
          setSuppliers((current) =>
            current.map((group) => ({
              ...group,
              lines: group.lines.map((line) => (line.orderId === orderId ? { ...line, comment } : line)),
            })),
          );
          setWriteFailures((current) => clearWriteFailure(current, failureId));
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setWriteFailures((current) =>
            upsertWriteFailure(current, {
              id: failureId,
              what: "Poznámka k objednávke",
              where: orderWhere(suppliers, orderId),
              detail: err instanceof Error ? err.message : "Uloženie poznámky sa nepodarilo.",
            }),
          );
        })
        .finally(() => {
          setBusyCommentOrderId(null);
        });
    },
    [onSessionExpired, suppliers],
  );

  // issue 149: `useDirtyEditorLineIds.ts` — riadky s PRÁVE TERAZ otvorenou
  // úpravou, výnimka z "skryť vybavené" filtra nižšie.
  const { dirtyEditorLineIds, setActive: onEditorActivityChange } = useDirtyEditorLineIds();

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
    (sum, group) => sum + group.lines.filter((line) => !isLineHiddenByFilter(line, hideResolved, dirtyEditorLineIds)).length,
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
      <OrderWriteFailuresBanner
        failures={writeFailures}
        onDismiss={() => {
          setWriteFailures([]);
        }}
      />
      {canChangeState && <OrderOpenStatusesPanel onSessionExpired={onSessionExpired} onSaved={load} />}
      {loaded && totalLines === 0 && (
        <p className="empty" data-testid="orders-empty">Zatiaľ nie sú žiadne otvorené objednávky.</p>
      )}
      {loaded && totalLines > 0 && (
        <OrdersToolbar
          suppliers={suppliers}
          selectedSupplier={selectedSupplier}
          onSelectSupplier={selectSupplier}
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
          dirtyEditorLineIds={dirtyEditorLineIds}
          onEditorActivityChange={onEditorActivityChange}
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
