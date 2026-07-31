import { useCallback, useState } from "react";
import {
  fetchSupplierOrderMailPreview,
  OrdersUnauthorizedError,
  sendSupplierOrderMail,
  type OrderMailPreview,
} from "./ordersApi.js";

// issue 64: mechanicky vyňaté z `OrdersSection.tsx` (#31 — náhľad + odoslanie
// objednávky mailom dodávateľovi + kopírovanie do schránky), BEZ ZMENY
// SPRÁVANIA — rovnaký zámer ako predchádzajúce extrakcie
// (`OrderLineRow.tsx`/`SupplierOrderGroup.tsx`, `.claude/rules/
// frontend-design.md`), len tentokrát vlastný HOOK namiesto komponenty: tento
// blok nemá vlastný markup, je to čisto stav + tri handlery, ktoré
// `SupplierActionsPanel` dostáva ako props. Extrakcia uvoľnila v
// `OrdersSection.tsx` miesto (eslint `max-lines: 400`) pre novú funkciu
// tohto ticketu (poznámka k objednávke) bez toho, aby sa čokoľvek z tejto
// mailovej logiky menilo.
export interface SupplierMailActions {
  readonly previewSupplier: string | null;
  readonly preview: OrderMailPreview | null;
  readonly previewError: string;
  readonly sendBusy: boolean;
  readonly sendResult: { readonly supplier: string; readonly message: string } | null;
  readonly openPreview: (supplier: string) => void;
  readonly closePreview: () => void;
  readonly confirmSend: (supplier: string) => void;
  readonly copyOrderToClipboard: (supplier: string) => void;
}

export function useSupplierMailActions(onSessionExpired: () => void): SupplierMailActions {
  const [previewSupplier, setPreviewSupplier] = useState<string | null>(null);
  const [preview, setPreview] = useState<OrderMailPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendResult, setSendResult] = useState<{ readonly supplier: string; readonly message: string } | null>(null);

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

  return {
    previewSupplier,
    preview,
    previewError,
    sendBusy,
    sendResult,
    openPreview,
    closePreview,
    confirmSend,
    copyOrderToClipboard,
  };
}
