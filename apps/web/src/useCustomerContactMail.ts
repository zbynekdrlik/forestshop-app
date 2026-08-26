import { useCallback, useRef, useState, type RefObject } from "react";
import {
  fetchCustomerContactPreview,
  OrdersUnauthorizedError,
  sendCustomerContactMail,
  type CustomerContactPreview,
} from "./ordersApi.js";

// issue 500/502: ručný e-mail zákazníkovi z riadku objednávky (@ tlačidlo).
// Zdieľané JADRO okna náhľadu — používa ho „Na objednanie" (`OrdersSection`) AJ
// „Riešiť" (`RiesitSection`), aby bola funkcia úplne identická (Štěpán: „nič
// nemeň, len ju tam vlož"). Rovnaký dvojkrokový tok ako „Nedostupné
// tovary"/„Zlúčenie objednávok": povinný náhľad zo servera → odoslanie s
// jednorazovým tokenom + (prípadne) ručne upraveným telom.

export interface PendingContact {
  readonly orderCode: string;
  readonly preview: CustomerContactPreview;
}

export interface CustomerContactMailApi {
  readonly pending: PendingContact | null;
  readonly body: string;
  readonly setBody: (value: string) => void;
  readonly busy: boolean;
  readonly error: string;
  // issue 191: spúšťacie tlačidlo si pamätáme pri kliknutí — dialóg naň vráti
  // fokus po zavretí (`MailPreviewDialog`'s `returnFocusRef`).
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly open: (orderCode: string, trigger: HTMLElement | null) => void;
  readonly confirmSend: () => void;
  readonly close: () => void;
}

export function useCustomerContactMail(onSessionExpired: () => void): CustomerContactMailApi {
  const [pending, setPending] = useState<PendingContact | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLElement | null>(null);

  const open = useCallback(
    (orderCode: string, trigger: HTMLElement | null) => {
      triggerRef.current = trigger;
      setError("");
      setBusy(true);
      fetchCustomerContactPreview(orderCode)
        .then((preview) => {
          setPending({ orderCode, preview });
          setBody(preview.text);
        })
        .catch((err: unknown) => {
          if (err instanceof OrdersUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setError(err instanceof Error ? err.message : "Náhľad e-mailu sa nepodarilo načítať.");
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [onSessionExpired],
  );

  const confirmSend = useCallback(() => {
    if (pending === null) return;
    setBusy(true);
    sendCustomerContactMail(pending.orderCode, pending.preview.previewToken, body)
      .then((result) => {
        if (!result.ok) {
          setError(result.error ?? "Odoslanie zlyhalo.");
          return;
        }
        setPending(null);
      })
      .catch((err: unknown) => {
        if (err instanceof OrdersUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError(err instanceof Error ? err.message : "Odoslanie zlyhalo.");
      })
      .finally(() => {
        setBusy(false);
      });
  }, [pending, body, onSessionExpired]);

  const close = useCallback(() => {
    setPending(null);
  }, []);

  return { pending, body, setBody, busy, error, triggerRef, open, confirmSend, close };
}
