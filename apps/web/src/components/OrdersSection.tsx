import { useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { Me } from "../api.js";
import {
  persistHideResolvedPreference,
  persistSelectedSupplier,
  readHideResolvedPreference,
  readSelectedSupplierPreference,
} from "../ordersDisplayPreferences.js";
import { OrdersRemainingCountContext } from "../ordersRemainingCountContext.js";
import { RiesitBadgeRefreshContext } from "../riesitBadgeContext.js";
import { isFloorRowHidden, isLineHiddenByFilter, isLineResolved } from "../ordersSummary.js";
import { useOrderLinesBoard } from "../useOrderLinesBoard.js";
import { useSelectedSupplierFallback } from "../useSelectedSupplierFallback.js";
import { OrderOpenStatusesPanel } from "./OrderOpenStatusesPanel.js";
import { OrdersOverviewTiles } from "./OrdersOverviewTiles.js";
import { OrdersToolbar } from "./OrdersToolbar.js";
import { OrderWriteFailuresBanner } from "./OrderWriteFailuresBanner.js";
import { SupplierOrderGroup } from "./SupplierOrderGroup.js";
import { CustomerContactDialog } from "./CustomerContactDialog.js";
import { useCustomerContactMail } from "../useCustomerContactMail.js";
import { fetchOpenOrders, NEZNAMY_DODAVATEL } from "../ordersApi.js";

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
  const canChangeState = CAN_CHANGE_STATE_ROLES.has(role);

  // issue 476: zmena stavu tu (klik na „Riešiť" v Na objednanie) môže pridať/
  // odobrať riadok v stave `riesit`, takže po nej refetchni menu odznak
  // „Riešiť" (rovnaký vzor ako issue 473). Provider žije v `App.tsx`; mimo
  // neho (samostatný render v teste) je to bezpečné no-op.
  const { refresh: refreshRiesitBadge } = useContext(RiesitBadgeRefreshContext);

  // issue 476: jadro obrazovky (dáta + mutácie + pomocné hooky) je zdieľané so
  // sekciou „Riešiť" cez `useOrderLinesBoard`. „Na objednanie" ťahá z
  // `/api/orders/open`, NEfiltruje na jeden stav (`keepOnlyState` vynechané) a
  // po zmene stavu refetchne riesit odznak.
  const board = useOrderLinesBoard({
    fetchLines: fetchOpenOrders,
    onSessionExpired,
    canChangeState,
    onStateChanged: refreshRiesitBadge,
  });
  const {
    suppliers,
    loaded,
    error,
    writeFailures,
    setWriteFailures,
    busyLineId,
    busyOrderedLineId,
    busyOrderedSupplier,
    busySupplierLineId,
    busySupplierLinkLineId,
    busyCommentOrderId,
    busyFloorRowKey,
    supplierDrafts,
    dirtyEditorLineIds,
    onEditorActivityChange,
    email,
    mail,
    setSupplierLink,
    load,
    changeState,
    changeOrdered,
    changeFloorOrdered,
    assignSupplier,
    changeComment,
    toggleGroupOrdered,
  } = board;

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

  // issue 147: publikuje počet NEVYBAVENÝCH RIADKOV (naprieč VŠETKÝMI
  // dodávateľmi) do ľavého menu cez `OrdersRemainingCountContext` — po KAŽDEJ
  // zmene `suppliers`, takže odznak je vždy aktuálny. Pred prvým úspešným
  // načítaním sa nevolá vôbec — Sidebar dovtedy odznak nevykreslí.
  // issue 260: zámerne NEJDE cez `summarizeOrderLines(...).remaining` — tá
  // odteraz sčítava KUSY (`quantity`); tento odznak má vlastný, samostatne
  // zdokumentovaný zámer "počet riadkov" (viď test). Počíta sa preto priamo
  // cez kanonický predikát `isLineResolved`.
  const { setCount: setOrdersRemainingCount } = useContext(OrdersRemainingCountContext);
  useEffect(() => {
    if (!loaded) return;
    const allLines = suppliers.flatMap((group) => group.lines);
    // issue 480: odznak počíta aj NEOBJEDNANÉ predajňové riadky (konzistentne s
    // tým, ako sa počítajú e-shopové — neobjednaný sa počíta, objednaný nie).
    const allFloorRows = suppliers.flatMap((group) => group.floorRows ?? []);
    setOrdersRemainingCount(
      allLines.filter((l) => !isLineResolved(l)).length + allFloorRows.filter((r) => !r.ordered).length,
    );
  }, [loaded, suppliers, setOrdersRemainingCount]);

  // issue 148 (vyňaté do `useSelectedSupplierFallback.ts`).
  useSelectedSupplierFallback(loaded, suppliers, selectedSupplier, selectSupplier);

  // issue 529: preklik 📦 z „Nedostupné tovary" (`?tab=orders&highlight=<kód>`,
  // celá navigácia stránky) — odkryje a zvýrazní riadok(y) daného variantu.
  // `highlightCode` sa číta z URL RAZ pri mounte (rovnaký vzor ako `initialTabId`
  // v `App.tsx`); `URLSearchParams.get` auto-dekóduje `/` v kóde variantu.
  const [highlightCode, setHighlightCode] = useState<string | null>(() => {
    const raw = new URLSearchParams(window.location.search).get("highlight");
    return raw !== null && raw !== "" ? raw : null;
  });
  // Zvýraznenie sa naskroluje LEN raz — ďalšie prekreslenia (refetch `suppliers`)
  // ho už neopakujú.
  const highlightScrolledRef = useRef(false);
  const highlightTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    },
    [],
  );
  const stripHighlightParam = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("highlight");
    window.history.replaceState(null, "", url);
  }, []);
  useEffect(() => {
    if (!loaded || highlightCode === null) return;
    const targetGroup = suppliers.find((group) => group.lines.some((line) => line.variantCode === highlightCode));
    if (targetGroup === undefined) {
      // Produkt už nie je medzi otvorenými objednávkami — nič na zvýraznenie.
      setHighlightCode(null);
      stripHighlightParam();
      return;
    }
    // Krok 1: odkry skupinu skrytú chip filtrom. `null` = „Všetci" (všetko sa
    // zobrazuje), vtedy netreba nič. Fallback hook nuluje LEN neplatný výber,
    // takže platný výber tu nastavený neprepíše. Return → efekt sa spustí znova
    // po prekreslení (branch-and-return, self-terminujúci).
    if (selectedSupplier !== null && selectedSupplier !== targetGroup.supplier) {
      selectSupplier(targetGroup.supplier);
      return;
    }
    // Krok 2: odkry riadok skrytý „skryť vybavené" — nedostupný riadok je
    // `isLineResolved` (state !== "objednane"). RAW setter NEpersistuje
    // preferenciu používateľa (perzistuje len `toggleHideResolved`).
    const targetHidden = hideResolved && targetGroup.lines.some((line) => line.variantCode === highlightCode && isLineResolved(line));
    if (targetHidden) {
      setHideResolved(false);
      return;
    }
    // Krok 3: viditeľné → naskroluj raz, odstráň URL param a po ~4 s zhasni.
    if (!highlightScrolledRef.current) {
      highlightScrolledRef.current = true;
      const el = document.querySelector('[data-order-highlight="true"]');
      // `scrollIntoView` v jsdom neexistuje (unit test) — v prehliadači vždy je.
      if (el !== null && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
      stripHighlightParam();
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightCode(null);
      }, 4000);
    }
  }, [loaded, suppliers, highlightCode, selectedSupplier, hideResolved, selectSupplier, stripHighlightParam]);

  // `/api/orders/open` už zoraďuje riadky presne tak, ako majú byť zobrazené
  // (dodávateľ vzostupne, potom najnovšia objednávka prvá) — žiadne ďalšie
  // preskupovanie na klientovi.
  const totalLines = suppliers.reduce((sum, group) => sum + group.lines.length, 0);
  // issue 480: prázdny stav / toolbar / hláška „skryť vybavené" berú do úvahy aj
  // predajňové riadky — skupina môže mať LEN predajňové riadky (žiadne
  // objednávky), a vtedy zoznam NIE JE prázdny.
  const totalFloorRows = suppliers.reduce((sum, group) => sum + (group.floorRows?.length ?? 0), 0);
  const totalRows = totalLines + totalFloorRows;

  // issue 61: dodávatelia zúžení podľa vybraného chipu — hromadné akcie
  // (`SupplierActionsPanel`) dostávajú vždy PLNÉ `group.lines` (nefiltrované
  // podľa `hideResolved`), lebo server aj tak mutuje celú skupinu naraz;
  // filtrovaný pohľad je len na to, ktoré RIADKY tabuľky sa vykreslia.
  const filteredGroups = suppliers.filter(
    (group) => selectedSupplier === null || group.supplier === selectedSupplier,
  );
  const visibleLinesCount = filteredGroups.reduce(
    (sum, group) =>
      sum +
      group.lines.filter((line) => !isLineHiddenByFilter(line, hideResolved, dirtyEditorLineIds)).length +
      (group.floorRows ?? []).filter((row) => !isFloorRowHidden(row, hideResolved)).length,
    0,
  );

  // issue 63: UŽ známe pravopisy dodávateľov (bez zástupného
  // "(bez dodávateľa)") pre `<datalist>` našepkávanie — z toho, čo appka UŽ
  // má načítané (`suppliers`), žiadna nová GET trasa netreba.
  const knownSuppliers = useMemo(
    () => [...new Set(suppliers.map((g) => g.supplier).filter((s) => s !== NEZNAMY_DODAVATEL))].sort(),
    [suppliers],
  );

  // issue 500: @ tlačidlo na riadku otvorí okno na ručný e-mail zákazníkovi —
  // zdieľané jadro (`useCustomerContactMail`) so sekciou „Riešiť" (#502), aby
  // bola funkcia identická.
  const contact = useCustomerContactMail(onSessionExpired);

  return (
    <section className="orders-section">
      {!loaded && <p>Načítavam otvorené objednávky…</p>}
      {error !== "" && <p role="alert">{error}</p>}
      {/* issue 237: blok dlaždíc NAD zoznamom — nezávislý od `loaded`/
          `totalLines` (vlastný stav vnútri), lebo "Prehľad e-shopu" má
          zmysel zobraziť aj keď "Na objednanie" nemá momentálne žiadny
          otvorený riadok. */}
      <OrdersOverviewTiles suppliers={suppliers} onSessionExpired={onSessionExpired} />
      <OrderWriteFailuresBanner
        failures={writeFailures}
        onDismiss={() => {
          setWriteFailures([]);
        }}
      />
      {canChangeState && <OrderOpenStatusesPanel onSessionExpired={onSessionExpired} onSaved={load} />}
      {loaded && totalRows === 0 && (
        <p className="empty" data-testid="orders-empty">Zatiaľ nie sú žiadne otvorené objednávky.</p>
      )}
      {loaded && totalRows > 0 && (
        <OrdersToolbar
          suppliers={suppliers}
          selectedSupplier={selectedSupplier}
          onSelectSupplier={selectSupplier}
          hideResolved={hideResolved}
          onToggleHideResolved={toggleHideResolved}
        />
      )}
      {loaded && totalRows > 0 && hideResolved && visibleLinesCount === 0 && (
        <p className="empty" data-testid="orders-hidden-empty">
          {selectedSupplier === null
            ? "Všetko vybavené — vybavené riadky sú skryté."
            : "Tento dodávateľ je vybavený — vybavené riadky sú skryté."}
        </p>
      )}
      {/* issue 63: JEDEN zdieľaný datalist pre všetky priraďovacie polia
          (`OrderLineRow.tsx`'s `list="known-suppliers"`). */}
      <datalist id="known-suppliers">
        {knownSuppliers.map((supplier) => (
          <option key={supplier} value={supplier} />
        ))}
      </datalist>
      {filteredGroups.map((group) => (
        <SupplierOrderGroup
          key={group.supplier}
          group={group}
          selectedSupplier={selectedSupplier}
          highlightVariantCode={highlightCode}
          hideResolved={hideResolved}
          dirtyEditorLineIds={dirtyEditorLineIds}
          onEditorActivityChange={onEditorActivityChange}
          supplierDrafts={supplierDrafts}
          canChangeState={canChangeState}
          busyLineId={busyLineId}
          busyOrderedLineId={busyOrderedLineId}
          busyOrderedSupplier={busyOrderedSupplier}
          busySupplierLineId={busySupplierLineId}
          busySupplierLinkLineId={busySupplierLinkLineId}
          busyCommentOrderId={busyCommentOrderId}
          busyFloorRowKey={busyFloorRowKey}
          onChangeState={changeState}
          onChangeOrdered={changeOrdered}
          onChangeFloorOrdered={changeFloorOrdered}
          onAssignSupplier={assignSupplier}
          onSetSupplierLink={setSupplierLink}
          onChangeComment={changeComment}
          editingEmailSupplier={email.editingEmailSupplier}
          emailDraft={email.emailDraft}
          emailBusy={email.emailBusy}
          emailError={email.emailError}
          onEmailDraftChange={email.onEmailDraftChange}
          onStartEditEmail={email.onStartEditEmail}
          onSaveEmail={email.onSaveEmail}
          onCancelEditEmail={email.onCancelEditEmail}
          onToggleGroupOrdered={toggleGroupOrdered}
          onCopyOrderToClipboard={mail.copyOrderToClipboard}
          previewSupplier={mail.previewSupplier}
          preview={mail.preview}
          previewError={mail.previewError}
          sendBusy={mail.sendBusy}
          sendResult={mail.sendResult}
          onOpenPreview={mail.openPreview}
          onClosePreview={mail.closePreview}
          onConfirmSend={mail.confirmSend}
          onOpenCustomerContact={contact.open}
        />
      ))}
      {/* issue 500: okno na ručný e-mail zákazníkovi — JEDNO na celú sekciu
          (zdieľané s „Riešiť" #502), otvorí ho @ tlačidlo ktoréhokoľvek riadku. */}
      <CustomerContactDialog contact={contact} />
    </section>
  );
}
