import type { JSX } from "react";
import type { CustomerContactMailApi } from "../useCustomerContactMail.js";
import { MailPreviewDialog } from "./MailPreviewDialog.js";

// issue 500/502: zdieľané okno na ručný e-mail zákazníkovi (@ tlačidlo na
// riadku) — jedno na celú sekciu, otvorí ho ktorýkoľvek riadok. Renderuje ho
// „Na objednanie" (`OrdersSection`) aj „Riešiť" (`RiesitSection`) rovnako, aby
// bola funkcia identická. Chyba náhľadu (napr. objednávka sa nenašla) sa
// zobrazí, keď okno NIE JE otvorené; chyby PRI otvorenom okne (napr. chýba BCC)
// idú priamo do okna.
export function CustomerContactDialog({ contact }: { readonly contact: CustomerContactMailApi }): JSX.Element {
  return (
    <>
      {contact.pending === null && contact.error !== "" && (
        <p role="alert" data-testid="customer-contact-error">
          {contact.error}
        </p>
      )}
      {contact.pending !== null && (
        <MailPreviewDialog
          testId="customer-contact-preview"
          title="Náhľad e-mailu — povinné pred odoslaním"
          recipient={contact.pending.preview.recipient}
          subject={contact.pending.preview.subject}
          bodyText={contact.body}
          onBodyTextChange={contact.setBody}
          confirmLabel="📧 Odoslať zákazníkovi"
          confirmDisabled={contact.busy || contact.body.trim() === ""}
          onConfirm={contact.confirmSend}
          returnFocusRef={contact.triggerRef}
          onClose={contact.close}
        >
          {contact.error !== "" && (
            <p role="alert" data-testid="customer-contact-dialog-error">
              {contact.error}
            </p>
          )}
        </MailPreviewDialog>
      )}
    </>
  );
}
