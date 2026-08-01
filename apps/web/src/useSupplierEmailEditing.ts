import { useCallback, useState } from "react";
import { OrdersUnauthorizedError, setSupplierEmail, type SupplierOpenOrders } from "./ordersApi.js";

// issue 66: mechanicky vyňaté z `OrdersSection.tsx` (#31 — úprava e-mailového
// kontaktu dodávateľa), BEZ ZMENY SPRÁVANIA — rovnaký zámer a vzor ako
// `useSupplierMailActions.ts`'s komentár vysvetľuje (issue 64): vlastný HOOK
// namiesto komponenty, lebo tento blok nemá vlastný markup, len stav + tri
// handlery, ktoré `SupplierActionsPanel` dostáva ako props. Extrakcia
// uvoľnila v `OrdersSection.tsx` miesto (eslint `max-lines: 400`) pre
// kumulatívne hlásenie o neuložených zmenách (tento ticket), bez zmeny
// e-mailovej logiky.
export interface SupplierEmailEditing {
  readonly editingEmailSupplier: string | null;
  readonly emailDraft: string;
  readonly emailBusy: boolean;
  readonly emailError: string;
  readonly onEmailDraftChange: (value: string) => void;
  readonly onStartEditEmail: (group: SupplierOpenOrders) => void;
  readonly onSaveEmail: (supplier: string) => void;
  readonly onCancelEditEmail: () => void;
}

export function useSupplierEmailEditing(
  setSuppliers: (updater: (current: readonly SupplierOpenOrders[]) => readonly SupplierOpenOrders[]) => void,
  onSessionExpired: () => void,
): SupplierEmailEditing {
  const [editingEmailSupplier, setEditingEmailSupplier] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState("");

  const onStartEditEmail = useCallback((group: SupplierOpenOrders) => {
    setEditingEmailSupplier(group.supplier);
    setEmailDraft(group.email ?? "");
    setEmailError("");
  }, []);

  const onCancelEditEmail = useCallback(() => {
    setEditingEmailSupplier(null);
    setEmailError("");
  }, []);

  const onSaveEmail = useCallback(
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
    [emailDraft, onSessionExpired, setSuppliers],
  );

  return {
    editingEmailSupplier,
    emailDraft,
    emailBusy,
    emailError,
    onEmailDraftChange: setEmailDraft,
    onStartEditEmail,
    onSaveEmail,
    onCancelEditEmail,
  };
}
