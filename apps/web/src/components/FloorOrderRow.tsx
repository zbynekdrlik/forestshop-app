import { useEffect, useRef, useState, type JSX } from "react";
import { formatSkDate } from "../formatDate.js";
import type { FloorOrderRow as FloorOrderRowData, OrderLine } from "../ordersApi.js";
import { STATE_LABELS } from "../orderLineStateLabels.js";
import { StateButtons } from "./OrderLineStateButtons.js";
import { OrderSupplierLinkDisplay } from "./OrderSupplierLinkDisplay.js";

// issue 162: počet stĺpcov tabuľky „Na objednanie" — MUSÍ sedieť s počtom
// `<col>` v `SupplierOrderGroup.tsx`'s `<colgroup>` (9). Rozbaľovací
// link-edit riadok pod týmto riadkom potrebuje `colSpan` cez celú šírku.
const ORDERS_TABLE_COLUMN_COUNT = 9;

// issue 480: JEDEN predajňový riadok v tabuľke „Na objednanie" — produkt
// pripnutý na nevybavenom zápise „Objednávky predajňa", zaradený pod svojho
// dodávateľa. Vykresľuje sa v TEJ ISTEJ tabuľke ako `OrderLineRow` (rovnakých
// 9 stĺpcov `<colgroup>` v `SupplierOrderGroup.tsx`).
//
// issue 575 (Štěpán): riadok predajne má mať ROVNAKÉ ovládanie ako e-shopová
// objednávka — kód s odkazom pod 🛍️, 🔗 odkaz na dodávateľa (+ ✏️ úprava
// cez PRODUKTOVÚ zdieľanú cestu `product-links`), stavové tlačidlá (stav uložený
// na `floor_note_product`) a per-položková poznámka. E-mail (@) NIE JE (predajňa
// e-mail zákazníka nemá). Ovládače skladá z EXISTUJÚCICH primitívov
// (`StateButtons`, `OrderSupplierLinkDisplay`, link-edit-row vzor).
//
// Testid ZÁMERNE nezačína „order-line-" — viacero e2e testov hľadá hlavný
// riadok cez `[data-testid^='order-line-']` (`.claude/rules/frontend-design.md`,
// issue 162); zhodný prefix by spôsobil Playwright strict-mode kolíziu.
export function FloorOrderRow({
  row,
  canChangeState,
  busyFloorRowKey,
  busyFloorStateKey,
  busyFloorCommentKey,
  busyFloorLinkKey,
  supplierBusy,
  onChangeOrdered,
  onChangeState,
  onChangeComment,
  onSetSupplierLink,
}: {
  readonly row: FloorOrderRowData;
  readonly canChangeState: boolean;
  // Kľúč (`noteId::variantCode`) floor riadku, ktorého daný zápis PRÁVE TERAZ
  // prebieha — `null` keď žiadny. Štyri nezávislé busy-guardy (objednané / stav
  // / poznámka / odkaz), presne ako order riadok má samostatné busy pre svoje
  // akcie.
  readonly busyFloorRowKey: string | null;
  readonly busyFloorStateKey: string | null;
  readonly busyFloorCommentKey: string | null;
  readonly busyFloorLinkKey: string | null;
  // TRUE, keď beží hromadné „označiť/zrušiť skupinu" pre dodávateľa tohto
  // riadku (obojsmerný busy-guard, issue 60).
  readonly supplierBusy: boolean;
  readonly onChangeOrdered: (noteId: string, variantCode: string, ordered: boolean) => void;
  // issue 575: zmena stavu / poznámky predajňového riadku + PRODUKTOVÝ zápis
  // odkazu na dodávateľa (kľúčované `productKey`, zdieľaná cesta s objednávkou).
  readonly onChangeState: (noteId: string, variantCode: string, newState: OrderLine["state"]) => void;
  readonly onChangeComment: (noteId: string, variantCode: string, comment: string | null) => void;
  // issue 166 vzor: `boolean` — `true` keď vstup prešiel validáciou a zápis sa
  // spustil, `false` keď bol okamžite odmietnutý (editor sa vtedy nezavrie).
  readonly onSetSupplierLink: (noteId: string, variantCode: string, productKey: string, url: string) => boolean;
}): JSX.Element {
  const rowKey = `${row.noteId}::${row.variantCode}`;
  const busyOrderedHere = busyFloorRowKey === rowKey;
  const stateBusyHere = busyFloorStateKey === rowKey;
  const commentBusyHere = busyFloorCommentKey === rowKey;
  const linkBusyHere = busyFloorLinkKey === rowKey;

  // issue 575: úprava odkazu na dodávateľa — TOGGLE (draft prednaplnený ČERSTVOU
  // hodnotou pri KAŽDOM otvorení, nie cez `useEffect`), rovnaký vzor ako
  // `OrderLineRow` (`.claude/rules/frontend-design.md` — toggled editor
  // nepotrebuje skip-first-mount guard).
  const [linkEditing, setLinkEditing] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const toggleLinkEditing = (): void => {
    if (linkEditing) {
      setLinkEditing(false);
      return;
    }
    setLinkDraft(row.supplierUrl ?? "");
    setLinkEditing(true);
  };
  const saveLink = (): void => {
    const trimmed = linkDraft.trim();
    if (trimmed === "") return;
    const accepted = onSetSupplierLink(row.noteId, row.variantCode, row.productKey, trimmed);
    if (accepted) setLinkEditing(false);
  };

  // issue 575: per-položková poznámka — controlled draft + „skip prvý mount" +
  // „dirty" guard (rovnaký vzor ako `OrderLineRow`'s komentár). Poznámka je PER
  // POLOŽKA (nie zdieľaná naprieč súrodencami ako `order.comment`), takže
  // súrodenecký guard netreba, ale dirty guard drží rozpísaný koncept pri
  // refetchi/optimistickom patchi.
  const [commentDraft, setCommentDraft] = useState(row.comment ?? "");
  const isCommentFirstMount = useRef(true);
  const isCommentDirty = useRef(false);
  useEffect(() => {
    if (isCommentFirstMount.current) {
      isCommentFirstMount.current = false;
      return;
    }
    if (isCommentDirty.current) return;
    setCommentDraft(row.comment ?? "");
  }, [row.comment]);
  const saveComment = (): void => {
    const trimmed = commentDraft.trim();
    isCommentDirty.current = false;
    onChangeComment(row.noteId, row.variantCode, trimmed === "" ? null : trimmed);
  };

  return (
    <>
      <tr
        className={"order-row floor-order-row" + (row.ordered ? " ordered" : "")}
        data-testid={`floor-order-row-${row.noteId}-${row.variantCode}`}
      >
        <td>
          <input
            type="checkbox"
            data-testid={`floor-ordered-checkbox-${row.noteId}-${row.variantCode}`}
            aria-label={`Označiť predajňový riadok ${row.variantCode} (zápis predajne) ako objednané u dodávateľa`}
            checked={row.ordered}
            disabled={!canChangeState || busyOrderedHere || supplierBusy}
            onChange={(e) => {
              onChangeOrdered(row.noteId, row.variantCode, e.target.checked);
            }}
          />
        </td>
        {/* Na mieste čísla objednávky: 🛍️ + odkaz na zápis v „Objednávky
            predajňa" (`?tab=floor-orders`), a POD ním kód produktu s odkazom
            na náš eshop (issue 575, ako order riadok). `ourUrl === null` →
            neaktívny text, nikdy vyhľadávací fallback (majiteľova podmienka). */}
        <td className="ord-order-cell">
          <a
            href="?tab=floor-orders"
            className="floor-order-link"
            data-testid={`floor-order-link-${row.noteId}-${row.variantCode}`}
            aria-label="Otvoriť zápis v Objednávky predajňa"
            title="Objednávka predajňa — otvoriť zápis"
          >
            <span aria-hidden="true">🛍️</span>
          </a>
          <div className="ord-code-cell floor-order-code" data-testid={`floor-code-${row.noteId}-${row.variantCode}`}>
            {row.ourUrl !== null ? (
              <a
                href={row.ourUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="ord-code-link"
                data-testid={`floor-code-link-${row.noteId}-${row.variantCode}`}
                aria-label={`Otvoriť produkt ${row.variantCode} na našom eshope`}
                title="Otvoriť produkt na našom eshope"
              >
                {row.variantCode}
              </a>
            ) : (
              <span className="ord-code-text" data-testid={`floor-code-text-${row.noteId}-${row.variantCode}`}>
                {row.variantCode}
              </span>
            )}
          </div>
        </td>
        {/* Meno zákazníka = prvý riadok textu zápisu (server ho už orezal). */}
        <td>{row.customerName}</td>
        {/* Produkt: názov + veľkosť (ako order riadok). */}
        <td>
          <div className="ord-product-name">
            {row.productName}
            {row.sizeLabel !== null && <span className="ord-size">{row.sizeLabel}</span>}
          </div>
        </td>
        <td className="ord-qty">
          <div className="ord-qty-stack">
            <span>{row.quantity} ks</span>
          </div>
        </td>
        {/* Dodávateľ: 🔗 odkaz (+ ✏️ úprava cez PRODUKTOVÚ zdieľanú cestu) — bez
            @ tlačidla (predajňa e-mail nemá), bez „priradiť dodávateľa" vstupu
            (dodávateľ je odvodený z produktu). */}
        <td className="ord-supplier-merged">
          <div className="ord-supplier-row">
            <div className="ord-supplier-top">
              <div className="ord-supplier-cell" data-testid={`floor-supplier-link-${row.noteId}-${row.variantCode}`}>
                <OrderSupplierLinkDisplay
                  data={{
                    supplierUrl: row.supplierUrl,
                    supplierNote: row.supplierNote,
                    supplierAssignable: false,
                    variantName: row.productName,
                    variantCode: row.variantCode,
                  }}
                />
              </div>
            </div>
            {canChangeState && (
              <button
                type="button"
                className="ord-supplier-link-edit-toggle"
                data-testid={`floor-supplier-link-edit-toggle-${row.noteId}-${row.variantCode}`}
                aria-label={
                  linkEditing
                    ? `Zrušiť úpravu odkazu na dodávateľa — ${row.productName} (${row.variantCode})`
                    : row.supplierUrl !== null
                      ? `Upraviť odkaz na dodávateľa — ${row.productName} (${row.variantCode})`
                      : `Doplniť odkaz na dodávateľa — ${row.productName} (${row.variantCode})`
                }
                title={linkEditing ? "Zrušiť úpravu" : row.supplierUrl !== null ? "Upraviť odkaz" : "Doplniť odkaz"}
                onClick={toggleLinkEditing}
              >
                <span aria-hidden="true">{linkEditing ? "✖" : "✏️"}</span>
              </button>
            )}
          </div>
        </td>
        {/* Stav: rovnaké stavové tlačidlá ako e-shopová objednávka (issue 575).
            Testid `state-btn-<s>-floor-<noteId>-<code>` — bez kolízie s
            `order-line-` prefixmi. */}
        <td>
          {canChangeState ? (
            <StateButtons
              idKey={`floor-${row.noteId}-${row.variantCode}`}
              state={row.state}
              ariaLabel={`Zmeniť stav predajňového riadku ${row.variantCode}`}
              busy={stateBusyHere || supplierBusy}
              onChange={(s) => {
                onChangeState(row.noteId, row.variantCode, s);
              }}
            />
          ) : (
            STATE_LABELS[row.state]
          )}
        </td>
        <td className="ord-date-cell">{formatSkDate(row.createdAt)}</td>
        {/* Poznámka: per-položková, uložená na `floor_note_product` (viditeľná
            aj v „Objednávky predajňa"). */}
        <td className="ord-notes-merged">
          <div className="ord-comment-cell" data-testid={`floor-comment-cell-${row.noteId}-${row.variantCode}`}>
            {canChangeState ? (
              <>
                <textarea
                  className="ord-comment-input"
                  data-testid={`floor-comment-input-${row.noteId}-${row.variantCode}`}
                  aria-label={`Poznámka k predajňovému riadku ${row.variantCode}`}
                  placeholder="poznámka…"
                  maxLength={2000}
                  rows={1}
                  value={commentDraft}
                  disabled={commentBusyHere}
                  onChange={(e) => {
                    isCommentDirty.current = true;
                    setCommentDraft(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      saveComment();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn sm good"
                  data-testid={`floor-comment-save-${row.noteId}-${row.variantCode}`}
                  aria-label={`Uložiť poznámku k predajňovému riadku ${row.variantCode}`}
                  title="Uložiť poznámku (Ctrl+Enter)"
                  disabled={commentBusyHere}
                  onClick={saveComment}
                >
                  💾
                </button>
              </>
            ) : (
              <span className="ord-comment-display">{row.comment ?? "—"}</span>
            )}
          </div>
        </td>
      </tr>
      {/* issue 575: úprava odkazu na dodávateľa sa rozbaľuje do VLASTNÉHO riadku
          POD daným riadkom, cez celú šírku (rovnaký `link-edit-row` vzor ako
          `OrderLineRow`). Testid `link-edit-row-floor-...` — ZÁMERNE nie prefix
          `order-line-` ani `link-edit-row-<lineId>` (bez kolízie). Ukladá cez
          PRODUKTOVÚ cestu (`product-links`, kľúč `productKey`). */}
      {linkEditing && (
        <tr className="ord-supplier-link-edit-row" data-testid={`link-edit-row-floor-${row.noteId}-${row.variantCode}`}>
          <td colSpan={ORDERS_TABLE_COLUMN_COUNT}>
            <div
              className="ord-supplier-link-edit"
              data-testid={`floor-supplier-link-edit-${row.noteId}-${row.variantCode}`}
            >
              <input
                type="url"
                className="ord-supplier-link-edit-input"
                data-testid={`floor-supplier-link-edit-input-${row.noteId}-${row.variantCode}`}
                aria-label={`Odkaz na dodávateľa predajňového riadku ${row.variantCode}`}
                placeholder="https://…"
                value={linkDraft}
                disabled={linkBusyHere}
                autoFocus
                onChange={(e) => {
                  setLinkDraft(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveLink();
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    toggleLinkEditing();
                  }
                }}
              />
              <button
                type="button"
                className="btn sm good"
                data-testid={`floor-supplier-link-edit-save-${row.noteId}-${row.variantCode}`}
                aria-label={`Uložiť odkaz na dodávateľa predajňového riadku ${row.variantCode}`}
                disabled={linkBusyHere || linkDraft.trim() === ""}
                onClick={saveLink}
              >
                💾
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
