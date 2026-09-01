import type { JSX } from "react";

// issue 529: poznámka objednávky na riadku „Nedostupné tovary", ktorá sa zapíše
// ako poznámka objednávky do eshopu (Shoptet) — TÁ ISTÁ zapisovacia cesta ako
// stĺpec POZNÁMKY v „Na objednanie" (`updateOrderComment` →
// `PUT /api/orders/:id/comment` → `order.comment` → writeback worker). Vyčlenené
// z `NedostupneSection.tsx` (repeated per-item rendering unit) kvôli eslint
// `max-lines: 400` — `NedostupneSection` ostáva vlastníkom stavu (draft mapa,
// busy, `updateOrderComment` volanie). `<textarea>` + 💾 (Ctrl+Enter), rovnaký
// vzor a `.ord-comment-input` štýl ako stĺpec POZNÁMKY.
export function NedostupneOrderNote({
  orderCode,
  variantCode,
  orderId,
  value,
  busy,
  saveDisabled,
  onChange,
  onSave,
}: {
  readonly orderCode: string;
  readonly variantCode: string;
  readonly orderId: string;
  readonly value: string;
  readonly busy: boolean;
  // Uloženie zablokované (prebieha zápis ALEBO sa poznámka nezmenila) — vstup
  // ostáva editovateľný (`disabled` len počas `busy`).
  readonly saveDisabled: boolean;
  readonly onChange: (value: string) => void;
  readonly onSave: (orderId: string, value: string) => void;
}): JSX.Element {
  return (
    <div className="nedostupne-order-note">
      <textarea
        className="ord-comment-input"
        data-testid={`nedostupne-note-input-${orderCode}-${variantCode}`}
        aria-label={`Poznámka do eshopu k objednávke ${orderCode}`}
        placeholder="poznámka…"
        maxLength={2000}
        rows={1}
        value={value}
        disabled={busy}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !saveDisabled) {
            e.preventDefault();
            onSave(orderId, value);
          }
        }}
      />
      <button
        type="button"
        className="btn sm good"
        data-testid={`nedostupne-note-save-${orderCode}-${variantCode}`}
        aria-label={`Uložiť poznámku do eshopu k objednávke ${orderCode}`}
        title="Uložiť poznámku (Ctrl+Enter)"
        disabled={saveDisabled}
        onClick={() => {
          onSave(orderId, value);
        }}
      >
        💾
      </button>
    </div>
  );
}
