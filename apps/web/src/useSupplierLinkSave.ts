import { useCallback, useState } from "react";
import {
  OrdersUnauthorizedError,
  setProductSupplierLink,
  validateSupplierLinkUrl,
  type SupplierOpenOrders,
} from "./ordersApi.js";
import { clearWriteFailure, lineWhere, upsertWriteFailure, type OrderWriteFailure } from "./ordersWriteFailures.js";

// issue 121: manuálny odkaz na dodávateľa — mechanicky vyňaté z
// `OrdersSection.tsx` (issue 153, ktoré pridalo okamžitú klientsku validáciu
// a poslalo súbor cez eslint `max-lines: 400`), BEZ ZMENY SPRÁVANIA — rovnaký
// zámer a vzor ako `useSupplierEmailEditing.ts`'s komentár vysvetľuje: vlastný
// HOOK namiesto komponenty, lebo tento blok nemá vlastný markup, len stav +
// jeden handler.
export interface SupplierLinkSave {
  readonly busySupplierLinkLineId: string | null;
  // issue 166: vracia `boolean` (predtým `void`) — `true` keď vstup prešiel
  // synchrónnou klientskou validáciou a zápis sa spustil, `false` keď bol
  // okamžite odmietnutý (žiadny sieťový zápis). Volajúci (`OrderLineRow.tsx`)
  // to používa na rozhodnutie, či zavrieť editor — pozri jeho komentár.
  readonly setSupplierLink: (lineId: string, url: string) => boolean;
}

export function useSupplierLinkSave(
  suppliers: readonly SupplierOpenOrders[],
  setWriteFailures: (updater: (current: readonly OrderWriteFailure[]) => readonly OrderWriteFailure[]) => void,
  load: () => void,
  onSessionExpired: () => void,
): SupplierLinkSave {
  const [busySupplierLinkLineId, setBusySupplierLinkLineId] = useState<string | null>(null);

  const setSupplierLink = useCallback(
    (lineId: string, url: string): boolean => {
      const failureId = `supplierLink:${lineId}`;
      const where = lineWhere(suppliers, lineId);
      // issue 153: OKAMŽITÁ kontrola V PREHLIADAČI, PRED akýmkoľvek zápisom
      // na server — zrkadlí presne server-strany pravidlo
      // (`validateSupplierLinkUrl`, `ordersApi.ts`). Neplatná hodnota sa
      // ukáže v tom istom kumulatívnom `writeFailures` banneri (issue 66)
      // ako každé iné zlyhanie zápisu na tejto obrazovke — žiadny nový,
      // samostatný chybový vzor. issue 166: `false` návratová hodnota tu je
      // presne to, čo `OrderLineRow.tsx`'s `saveLink()` potrebuje, aby
      // vedel, že editor NEMÁ zavrieť (predtým sa zatváral nepodmienene).
      const validationError = validateSupplierLinkUrl(url);
      if (validationError !== null) {
        setWriteFailures((current) =>
          upsertWriteFailure(current, { id: failureId, what: "Odkaz na dodávateľa", where, detail: validationError }),
        );
        return false;
      }
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
      return true;
    },
    [load, onSessionExpired, setWriteFailures, suppliers],
  );

  return { busySupplierLinkLineId, setSupplierLink };
}
