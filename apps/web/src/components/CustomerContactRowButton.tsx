import type { JSX } from "react";

// issue 500/502: @ tlačidlo (ručný e-mail zákazníkovi) na riadku „Na
// objednanie" (`OrderLineRow`) AJ „Riešiť" (`RiesitOrderRow`) — zdieľané, aby
// bolo v oboch sekciách identické. `testIdKey` je JEDINEČNÝ kľúč riadku (lineId
// v „Na objednanie", kde jedna objednávka môže mať viac riadkov s tým istým
// číslom; externalOrderId v „Riešiť", kde riadok je per-objednávka), `orderCode`
// je číslo objednávky pre náhľad, `customerName` len pre `aria-label`. Spúšťací
// prvok ide do `onOpen` (návrat fokusu po zavretí dialógu).
export function CustomerContactRowButton({
  testIdKey,
  orderCode,
  customerName,
  onOpen,
}: {
  readonly testIdKey: string;
  readonly orderCode: string;
  readonly customerName: string;
  readonly onOpen: (orderCode: string, trigger: HTMLElement | null) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="customer-contact-btn"
      data-testid={`customer-contact-open-${testIdKey}`}
      aria-label={`Napísať e-mail zákazníkovi ${customerName} k objednávke ${orderCode}`}
      title="Napísať e-mail zákazníkovi"
      onClick={(e) => {
        onOpen(orderCode, e.currentTarget);
      }}
    >
      <span aria-hidden="true">@</span>
    </button>
  );
}
