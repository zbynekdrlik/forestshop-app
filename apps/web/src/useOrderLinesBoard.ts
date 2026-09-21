import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  assignOrderLineSupplier as assignOrderLineSupplierApi,
  OrdersUnauthorizedError,
  setSupplierLinesOrdered,
  updateOrderComment,
  updateOrderLineOrdered,
  updateOrderLineState,
  type OrderLine,
  type SupplierOpenOrders,
} from "./ordersApi.js";
import type { OrderLineStateValue } from "./orderLineStates.js";
import { clearWriteFailure, lineWhere, orderWhere, upsertWriteFailure, type OrderWriteFailure } from "./ordersWriteFailures.js";
import { useDirtyEditorLineIds } from "./useDirtyEditorLineIds.js";
import { useFloorRowMutations } from "./useFloorRowMutations.js";
import { useSupplierDrafts } from "./useSupplierDrafts.js";
import { useSupplierEmailEditing } from "./useSupplierEmailEditing.js";
import { useSupplierLinkSave } from "./useSupplierLinkSave.js";
import { useSupplierMailActions } from "./useSupplierMailActions.js";

// issue 476: zdieľané JADRO obrazoviek „Na objednanie" (`OrdersSection`) a
// „Riešiť" (`RiesitSection`) — dáta (`suppliers`), všetky per-riadkové/
// per-skupinové mutácie (stav, objednané, priradenie dodávateľa, odkaz,
// poznámka, hromadné objednané) a všetky pomocné hooky (koncepty priradenia,
// „dirty" editory, e-mail dodávateľa, náhľad/odoslanie mailu). Obe obrazovky
// zdieľajú TÚ ISTÚ logiku — líšia sa len (a) ODKIAĽ ťahajú riadky (`fetchLines`
// — `/api/orders/open` vs `/api/orders/riesit`), (b) či sa riadok po zmene
// stavu z pohľadu odstráni (`keepOnlyState`), a (c) refetchom menu odznaku
// (`onStateChanged`). Vyňaté z pôvodného `OrdersSection.tsx`, ktoré teraz len
// tento hook konzumuje + rendruje vlastné JSX (dlaždice/toolbar/filtre) — jeho
// existujúce unit testy overujú, že správanie ostalo 1:1.
export interface OrderLinesBoardOptions {
  readonly fetchLines: () => Promise<readonly SupplierOpenOrders[]>;
  readonly onSessionExpired: () => void;
  readonly canChangeState: boolean;
  // Sekcia „Riešiť" posiela `"riesit"` — riadok, ktorého stav sa zmení na
  // čokoľvek INÉ, sa z lokálneho pohľadu ODSTRÁNI (a prázdna skupina zmizne),
  // presne podľa zadania „zmena stavu na iný → zo sekcie zmizne". „Na
  // objednanie" ho nechá `undefined` → riadok ostane, len zmení stav (1:1
  // pôvodné správanie).
  readonly keepOnlyState?: OrderLineStateValue;
  // Volané po KAŽDEJ úspešnej zmene stavu — obe sekcie ho použijú na refetch
  // menu odznaku „Riešiť" (zmena stavu môže riesit riadok pridať aj odobrať).
  readonly onStateChanged?: () => void;
  // Hláška pri zlyhaní načítania zoznamu — predvolene text „Na objednanie"
  // (zachováva pôvodné správanie OrdersSection 1:1). Sekcia Riešiť ho prepíše.
  readonly loadErrorMessage?: string;
}

export function useOrderLinesBoard(options: OrderLinesBoardOptions): {
  readonly suppliers: readonly SupplierOpenOrders[];
  readonly loaded: boolean;
  readonly error: string;
  readonly writeFailures: readonly OrderWriteFailure[];
  readonly setWriteFailures: Dispatch<SetStateAction<readonly OrderWriteFailure[]>>;
  readonly busyLineId: string | null;
  readonly busyOrderedLineId: string | null;
  readonly busyOrderedSupplier: string | null;
  readonly busySupplierLineId: string | null;
  readonly busySupplierLinkLineId: string | null;
  readonly busyCommentOrderId: string | null;
  // issue 480: kľúč (`noteId::variantCode`) predajňového riadku, ktorého zápis
  // „objednané" PRÁVE TERAZ prebieha.
  readonly busyFloorRowKey: string | null;
  // issue 575: samostatné busy-guardy pre stav / poznámku / odkaz predajňového
  // riadku (kľúč `noteId::variantCode`) — nezávislé od „objednané" vyššie.
  readonly busyFloorStateKey: string | null;
  readonly busyFloorCommentKey: string | null;
  readonly busyFloorLinkKey: string | null;
  readonly supplierDrafts: ReturnType<typeof useSupplierDrafts>;
  readonly dirtyEditorLineIds: ReadonlySet<string>;
  readonly onEditorActivityChange: (lineId: string, active: boolean) => void;
  readonly email: ReturnType<typeof useSupplierEmailEditing>;
  readonly mail: ReturnType<typeof useSupplierMailActions>;
  readonly setSupplierLink: (lineId: string, url: string) => boolean;
  readonly load: () => void;
  readonly changeState: (lineId: string, newState: OrderLineStateValue) => void;
  readonly changeOrdered: (lineId: string, ordered: boolean) => void;
  // issue 480: prepnutie „objednané" na predajňovom riadku.
  readonly changeFloorOrdered: (noteId: string, variantCode: string, ordered: boolean) => void;
  // issue 575: zmena stavu / poznámky / odkazu predajňového riadku.
  readonly changeFloorState: (noteId: string, variantCode: string, newState: OrderLineStateValue) => void;
  readonly changeFloorComment: (noteId: string, variantCode: string, comment: string | null) => void;
  readonly setFloorLink: (noteId: string, variantCode: string, productKey: string, url: string) => boolean;
  readonly assignSupplier: (lineId: string, supplier: string) => void;
  readonly changeComment: (orderId: string, comment: string | null) => void;
  readonly toggleGroupOrdered: (supplier: string, ordered: boolean) => void;
} {
  const { fetchLines, onSessionExpired, keepOnlyState, onStateChanged } = options;
  const loadErrorMessage = options.loadErrorMessage ?? "Otvorené objednávky sa nepodarilo načítať.";
  const [suppliers, setSuppliers] = useState<readonly SupplierOpenOrders[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [writeFailures, setWriteFailures] = useState<readonly OrderWriteFailure[]>([]);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const [busyOrderedLineId, setBusyOrderedLineId] = useState<string | null>(null);
  const [busyOrderedSupplier, setBusyOrderedSupplier] = useState<string | null>(null);
  const [busySupplierLineId, setBusySupplierLineId] = useState<string | null>(null);
  const [busyCommentOrderId, setBusyCommentOrderId] = useState<string | null>(null);

  // #31: e-mailový kontakt dodávateľa (editovateľný v zozname).
  const email = useSupplierEmailEditing(setSuppliers, onSessionExpired);
  // #31: náhľad + potvrdenie pred odoslaním objednávky mailom.
  const mail = useSupplierMailActions(onSessionExpired);
  // issue 151: rozpísaný koncept priradenia dodávateľa (zosúlaďuje sa sám).
  const supplierDrafts = useSupplierDrafts(suppliers);

  const load = useCallback(() => {
    fetchLines()
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
        setError(loadErrorMessage);
      });
  }, [fetchLines, onSessionExpired, loadErrorMessage]);

  useEffect(load, [load]);

  const changeState = useCallback(
    (lineId: string, newState: OrderLineStateValue) => {
      const failureId = `state:${lineId}`;
      setBusyLineId(lineId);
      updateOrderLineState(lineId, newState)
        .then(() => {
          // Lokálna aktualizácia namiesto plného refetchu — server už potvrdil
          // zápis (aj audit). V sekcii Riešiť (`keepOnlyState`) sa riadok, čo
          // stav opustil, z pohľadu odstráni a prázdna skupina zmizne.
          setSuppliers((current) => {
            const removeLine = keepOnlyState !== undefined && newState !== keepOnlyState;
            const mapped = current.map((group) => ({
              ...group,
              lines: removeLine
                ? group.lines.filter((line) => line.lineId !== lineId)
                : group.lines.map((line) => (line.lineId === lineId ? { ...line, state: newState } : line)),
            }));
            // issue 575: skupina zmizne LEN keď nemá ani objednávkový ANI
            // predajňový riadok — floor-only skupina (napr. v „Riešiť") nesmie
            // vypadnúť len preto, že jej posledný ORDER riadok opustil stav.
            return removeLine
              ? mapped.filter((group) => group.lines.length > 0 || (group.floorRows ?? []).length > 0)
              : mapped;
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
    [keepOnlyState, onSessionExpired, onStateChanged, suppliers],
  );

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
          // issue 89: `load()` aj po zamietnutí, inak by staré vstupné pole
          // zostalo viditeľné navždy (viď pôvodný komentár v OrdersSection).
          load();
        })
        .finally(() => {
          setBusySupplierLineId(null);
        });
    },
    [load, onSessionExpired, suppliers],
  );

  const { busySupplierLinkLineId, setSupplierLink } = useSupplierLinkSave(suppliers, setWriteFailures, load, onSessionExpired);

  // issue 480/575: predajňové (floor) riadkové mutácie (objednané / stav /
  // poznámka / odkaz) — vyňaté do vlastného hooku (`.claude/rules/frontend-
  // design.md`'s max-lines extrakcia). Board zostáva vlastníkom
  // `suppliers`/`writeFailures`, odovzdáva sem len ich settery.
  const floor = useFloorRowMutations({ setSuppliers, setWriteFailures, keepOnlyState, onStateChanged, onSessionExpired, load });

  const toggleGroupOrdered = useCallback(
    (supplier: string, ordered: boolean) => {
      const failureId = `groupOrdered:${supplier}`;
      setBusyOrderedSupplier(supplier);
      setSupplierLinesOrdered(supplier, ordered)
        .then(() => {
          // issue 480: hromadná akcia prepne objednávkové AJ predajňové riadky
          // skupiny (server `setSupplierLinesOrdered` mutuje oboje).
          setSuppliers((current) =>
            current.map((group) =>
              group.supplier === supplier
                ? {
                    ...group,
                    lines: group.lines.map((line) => ({ ...line, ordered })),
                    floorRows: (group.floorRows ?? []).map((row) => ({ ...row, ordered })),
                  }
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

  // issue 149: riadky s PRÁVE TERAZ otvorenou úpravou (výnimka z „skryť
  // vybavené" filtra).
  const { dirtyEditorLineIds, setActive: onEditorActivityChange } = useDirtyEditorLineIds();

  return {
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
    // issue 480/575: predajňové (floor) riadkové mutácie + ich busy-guardy
    // (`useFloorRowMutations`).
    ...floor,
    supplierDrafts,
    dirtyEditorLineIds,
    onEditorActivityChange,
    email,
    mail,
    setSupplierLink,
    load,
    changeState,
    changeOrdered,
    assignSupplier,
    changeComment,
    toggleGroupOrdered,
  };
}
