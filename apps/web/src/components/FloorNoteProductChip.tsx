import { useEffect, useRef, useState, type JSX } from "react";
import type { FloorNoteProduct } from "../floorNotesApi.js";
import { ourProductLink } from "../shopLinks.js";

// issue 453: jeden pripnutý produkt na zázname "Objednávky predajne" —
// klikateľný odkaz (priamy alebo vizuálne odlíšený náhradný, issue 410) +
// POČET KUSOV. Vyčlenené z `FloorNoteRow.tsx` do vlastného komponentu,
// pretože per-produktový vstup na počet potrebuje vlastný stav (hooks sa
// nedajú volať v `.map()` callbacku) — rovnaký princíp ako `OrderLineRow.tsx`
// vyčlenené z `OrdersSection.tsx` (issue 60).
const MAX_QUANTITY = 1_000_000;
function clampQuantity(raw: string): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(MAX_QUANTITY, Math.max(1, n)) : 1;
}

export function FloorNoteProductChip({
  product,
  noteId,
  busy,
  canEdit,
  onDetach,
  onUpdateQuantity,
}: {
  readonly product: FloorNoteProduct;
  readonly noteId: string;
  readonly busy: boolean;
  readonly canEdit: boolean;
  readonly onDetach: () => void;
  readonly onUpdateQuantity: (quantity: number) => void;
}): JSX.Element {
  const isFallback = product.shopUrl === null;
  const href = ourProductLink(product.variantCode, product.shopUrl);
  const label = product.sizeLabel !== null ? `${product.productName} (${product.sizeLabel})` : product.productName;

  const [qtyDraft, setQtyDraft] = useState(() => String(product.quantity));
  // Sync draft z prop-u LEN pri skutočnej zmene množstva, nie pri mount-e —
  // "skip-first-mount" vzor (`.claude/rules/frontend-design.md`, issue
  // 63/89): bez guardu by pasívny mount-time efekt mohol prepísať práve
  // rozpísanú hodnotu (race). `product.quantity` je per-(zápis,variant),
  // nie zdieľaný medzi chipmi, takže extra "dirty" guard netreba.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setQtyDraft(String(product.quantity));
  }, [product.quantity]);

  const commitQty = (): void => {
    const clamped = clampQuantity(qtyDraft);
    if (clamped !== product.quantity) {
      onUpdateQuantity(clamped);
    } else if (qtyDraft !== String(product.quantity)) {
      // Normalizuj zobrazenie (napr. "03"/"" → aktuálna hodnota) bez zbytočného zápisu.
      setQtyDraft(String(product.quantity));
    }
  };

  return (
    <span className="floor-note-product-chip" data-testid={`floor-note-product-${noteId}-${product.variantCode}`}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={isFallback ? "floor-note-product-link floor-note-product-link-fallback" : "floor-note-product-link"}
        title={isFallback ? "Priama adresa produktu nie je známa — otvorí vyhľadávanie na eshope" : undefined}
        data-testid={`floor-note-product-link-${noteId}-${product.variantCode}`}
      >
        {label}
      </a>
      {isFallback && <span className="floor-note-product-fallback-note">🔎 hľadať na eshope</span>}

      {canEdit ? (
        <span className="floor-note-product-qty-edit">
          <input
            type="number"
            min={1}
            max={MAX_QUANTITY}
            className="floor-note-product-qty-input"
            aria-label={`Počet kusov — ${label}`}
            value={qtyDraft}
            disabled={busy}
            onChange={(e) => {
              setQtyDraft(e.target.value);
            }}
            onBlur={commitQty}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            data-testid={`floor-note-product-qty-input-${noteId}-${product.variantCode}`}
          />
          <span className="floor-note-product-qty-unit">ks</span>
        </span>
      ) : (
        <span className="floor-note-product-qty" data-testid={`floor-note-product-qty-${noteId}-${product.variantCode}`}>
          {product.quantity} ks
        </span>
      )}

      {canEdit && (
        <button
          type="button"
          className="floor-note-icon-btn"
          disabled={busy}
          onClick={onDetach}
          title="Odopnúť"
          aria-label={`Odopnúť produkt ${product.productName} zo zápisu ${noteId}`}
          data-testid={`floor-note-product-detach-${noteId}-${product.variantCode}`}
        >
          ✖
        </button>
      )}
    </span>
  );
}
