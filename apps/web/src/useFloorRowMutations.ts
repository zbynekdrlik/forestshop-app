import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import {
  OrdersUnauthorizedError,
  setFloorRowComment,
  setFloorRowOrdered,
  setFloorRowState,
  setFloorRowSupplierLink,
  validateSupplierLinkUrl,
  type OrderLine,
  type SupplierOpenOrders,
} from "./ordersApi.js";
import type { OrderLineStateValue } from "./orderLineStates.js";
import { clearWriteFailure, upsertWriteFailure, type OrderWriteFailure } from "./ordersWriteFailures.js";

// issue 480/575: predajňové (floor) riadkové mutácie board-u „Na objednanie"
// (objednané / stav / poznámka / odkaz na dodávateľa) — mechanicky vyňaté z
// `useOrderLinesBoard.ts` (issue 575 ho poslalo cez eslint `max-lines: 400`,
// rovnaký vzor ako `useSupplierLinkSave.ts`/`useSupplierEmailEditing.ts`).
// `useOrderLinesBoard` zostáva vlastníkom `suppliers`/`writeFailures` stavu a
// odovzdáva sem len ich settery + `keepOnlyState`/`onStateChanged`/`load`.
export interface FloorRowMutations {
  // Kľúč (`noteId::variantCode`) predajňového riadku, ktorého daný zápis PRÁVE
  // TERAZ prebieha — štyri nezávislé busy-guardy.
  readonly busyFloorRowKey: string | null;
  readonly busyFloorStateKey: string | null;
  readonly busyFloorCommentKey: string | null;
  readonly busyFloorLinkKey: string | null;
  readonly changeFloorOrdered: (noteId: string, variantCode: string, ordered: boolean) => void;
  readonly changeFloorState: (noteId: string, variantCode: string, newState: OrderLineStateValue) => void;
  readonly changeFloorComment: (noteId: string, variantCode: string, comment: string | null) => void;
  // issue 166 vzor: `boolean` — `true` keď vstup prešiel validáciou a zápis sa
  // spustil, `false` keď bol okamžite odmietnutý (editor sa vtedy nezatvorí).
  readonly setFloorLink: (noteId: string, variantCode: string, productKey: string, url: string) => boolean;
}

export function useFloorRowMutations(deps: {
  readonly setSuppliers: Dispatch<SetStateAction<readonly SupplierOpenOrders[]>>;
  readonly setWriteFailures: Dispatch<SetStateAction<readonly OrderWriteFailure[]>>;
  // Sekcia „Riešiť" posiela `"riesit"` — floor riadok, ktorého stav sa zmení na
  // čokoľvek INÉ, sa z lokálneho pohľadu ODSTRÁNI (zrkadlí order-line
  // `changeState`'s `keepOnlyState`).
  readonly keepOnlyState: OrderLineStateValue | undefined;
  readonly onStateChanged: (() => void) | undefined;
  readonly onSessionExpired: () => void;
  readonly load: () => void;
}): FloorRowMutations {
  const { setSuppliers, setWriteFailures, keepOnlyState, onStateChanged, onSessionExpired, load } = deps;
  const [busyFloorRowKey, setBusyFloorRowKey] = useState<string | null>(null);
  const [busyFloorStateKey, setBusyFloorStateKey] = useState<string | null>(null);
  const [busyFloorCommentKey, setBusyFloorCommentKey] = useState<string | null>(null);
  const [busyFloorLinkKey, setBusyFloorLinkKey] = useState<string | null>(null);

  // issue 480: „objednané" na predajňovom riadku — lokálny patch `ordered`.
  const changeFloorOrdered = useCallback(
    (noteId: string, variantCode: string, ordered: boolean) => {
      const rowKey = `${noteId}::${variantCode}`;
      const failureId = `floorOrdered:${rowKey}`;
      setBusyFloorRowKey(rowKey);
      setFloorRowOrdered(noteId, variantCode, ordered)
        .then(() => {
          setSuppliers((current) =>
            current.map((group) => ({
              ...group,
              floorRows: (group.floorRows ?? []).map((row) =>
                row.noteId === noteId && row.variantCode === variantCode ? { ...row, ordered } : row,
              ),
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
              what: "Príznak objednané (predajňa)",
              where: `predajňový riadok ${variantCode}`,
              detail: err instanceof Error ? err.message : "Zmena príznaku objednané sa nepodarila.",
            }),
          );
        })
        .finally(() => {
          setBusyFloorRowKey(null);
        });
    },
    [setSuppliers, setWriteFailures, onSessionExpired],
  );

  // issue 575: zmena stavu predajňového riadku — zrkadlí order-line
  // `changeState` (lokálny patch, `keepOnlyState` odstráni riadok pri odchode zo
  // stavu, `onStateChanged` refetchne menu odznak „Riešiť").
  const changeFloorState = useCallback(
    (noteId: string, variantCode: string, newState: OrderLineStateValue) => {
      const rowKey = `${noteId}::${variantCode}`;
      const failureId = `floorState:${rowKey}`;
      setBusyFloorStateKey(rowKey);
      setFloorRowState(noteId, variantCode, newState)
        .then(() => {
          setSuppliers((current) => {
            const removeRow = keepOnlyState !== undefined && newState !== keepOnlyState;
            const mapped = current.map((group) => ({
              ...group,
              floorRows: removeRow
                ? (group.floorRows ?? []).filter((row) => !(row.noteId === noteId && row.variantCode === variantCode))
                : (group.floorRows ?? []).map((row) =>
                    row.noteId === noteId && row.variantCode === variantCode ? { ...row, state: newState } : row,
                  ),
            }));
            // Skupina zmizne LEN keď nemá ani objednávkový ANI predajňový riadok.
            return removeRow ? mapped.filter((group) => group.lines.length > 0 || group.floorRows.length > 0) : mapped;
          });
          setWriteFailures((current) => clearWriteFailure(current, failureId));
          onStateChanged?.();
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setWriteFailures((current) =>
            upsertWriteFailure(current, {
              id: failureId,
              what: "Zmena stavu (predajňa)",
              where: `predajňový riadok ${variantCode}`,
              detail: err instanceof Error ? err.message : "Zmena stavu sa nepodarila.",
            }),
          );
        })
        .finally(() => {
          setBusyFloorStateKey(null);
        });
    },
    [keepOnlyState, onStateChanged, onSessionExpired, setSuppliers, setWriteFailures],
  );

  // issue 575: per-položková poznámka — lokálny patch po úspechu.
  const changeFloorComment = useCallback(
    (noteId: string, variantCode: string, comment: string | null) => {
      const rowKey = `${noteId}::${variantCode}`;
      const failureId = `floorComment:${rowKey}`;
      setBusyFloorCommentKey(rowKey);
      setFloorRowComment(noteId, variantCode, comment)
        .then(() => {
          setSuppliers((current) =>
            current.map((group) => ({
              ...group,
              floorRows: (group.floorRows ?? []).map((row) =>
                row.noteId === noteId && row.variantCode === variantCode ? { ...row, comment } : row,
              ),
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
              what: "Poznámka (predajňa)",
              where: `predajňový riadok ${variantCode}`,
              detail: err instanceof Error ? err.message : "Uloženie poznámky sa nepodarilo.",
            }),
          );
        })
        .finally(() => {
          setBusyFloorCommentKey(null);
        });
    },
    [setSuppliers, setWriteFailures, onSessionExpired],
  );

  // issue 575: odkaz na dodávateľa — PRODUKTOVÁ zdieľaná cesta (`product-links`,
  // kľúč `productKey`), okamžitá klientska validácia + `boolean` návratová
  // hodnota ako `useSupplierLinkSave`. Po úspechu PLNÝ refetch (`load()`) — zmena
  // platí pre celý PRODUKT (aj súrodenecké objednávkové/predajňové riadky).
  const setFloorLink = useCallback(
    (noteId: string, variantCode: string, productKey: string, url: string): boolean => {
      const rowKey = `${noteId}::${variantCode}`;
      const failureId = `floorLink:${rowKey}`;
      const where = `predajňový riadok ${variantCode}`;
      const validationError = validateSupplierLinkUrl(url);
      if (validationError !== null) {
        setWriteFailures((current) =>
          upsertWriteFailure(current, { id: failureId, what: "Odkaz na dodávateľa (predajňa)", where, detail: validationError }),
        );
        return false;
      }
      setBusyFloorLinkKey(rowKey);
      setFloorRowSupplierLink(productKey, url)
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
              what: "Odkaz na dodávateľa (predajňa)",
              where,
              detail: err instanceof Error ? err.message : "Uloženie odkazu na dodávateľa sa nepodarilo.",
            }),
          );
        })
        .finally(() => {
          setBusyFloorLinkKey(null);
        });
      return true;
    },
    [load, onSessionExpired, setWriteFailures],
  );

  return {
    busyFloorRowKey,
    busyFloorStateKey,
    busyFloorCommentKey,
    busyFloorLinkKey,
    changeFloorOrdered,
    changeFloorState,
    changeFloorComment,
    setFloorLink,
  };
}
