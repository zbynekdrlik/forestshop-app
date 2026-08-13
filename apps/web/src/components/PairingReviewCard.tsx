import type { JSX } from "react";
import type { PairingReviewItem } from "../pairingReviewApi.js";

// issue 387 E5: karta jedného produktu, vyčlenená VOPRED z `PairingReviewSection.tsx`
// (rovnaký princíp ako `OrderLineRow.tsx`/`UpozornenieCard.tsx` — dvojstĺpcová
// karta má dosť JSX na prekročenie eslint `max-lines: 400` v jednom súbore,
// `.claude/rules/frontend-design.md`). ČISTO zobrazovacia — E5 je LEN
// čítanie, žiadne callbacky/akcie (tie prídu v E6).

const STATE_LABELS: Readonly<Record<PairingReviewItem["productState"], string>> = {
  sellable: "🟢 Skladom",
  out_of_stock: "📦 Nie je skladom",
  discontinued: "🚫 Už sa nebude predávať",
};

const CONFIDENCE_LABELS: Readonly<Record<PairingReviewItem["confidence"], string>> = {
  high: "vysoká istota",
  medium: "stredná istota",
  low: "nízka istota",
  none: "žiadna",
};

const VERDICT_LABELS: Readonly<Record<NonNullable<PairingReviewItem["verdict"]>, string>> = {
  ok: "✓ kód overený na stránke",
  unsure: "kód sa na stránke nenašiel",
};

function formatPriceRange(item: PairingReviewItem): string | null {
  if (item.priceMin === null || item.priceMax === null) return null;
  const currencySuffix = item.currency !== null && item.currency !== "" && item.currency !== "EUR" ? ` ${item.currency}` : " €";
  if (item.priceMin === item.priceMax) return `${item.priceMin}${currencySuffix}`;
  return `${item.priceMin}–${item.priceMax}${currencySuffix}`;
}

export function PairingReviewCard({ item }: { readonly item: PairingReviewItem }): JSX.Element {
  const priceRange = formatPriceRange(item);
  const codes = item.externalCodes.length > 0 ? item.externalCodes.join(", ") : "—";

  return (
    <div className="card pairing-review-card" data-testid={`pairing-review-card-${item.productKey}`}>
      <div className="pairing-review-grid">
        <div className="pairing-review-side">
          <div className="pairing-review-label">Náš produkt</div>
          <a
            className="pairing-review-name"
            href={item.ourUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`pairing-review-our-link-${item.productKey}`}
          >
            {item.productName}
          </a>
          <div className="pairing-review-meta">
            {item.supplier ?? "(bez dodávateľa)"} · kódy: {codes} · {String(item.variantCount)} variant(ov)
          </div>
          <span
            className={"pairing-review-state-badge pairing-review-state-" + item.productState}
            data-testid={`pairing-review-state-${item.productKey}`}
          >
            {STATE_LABELS[item.productState]}
          </span>
          {priceRange !== null && <div className="pairing-review-price">💶 {priceRange}</div>}
          <div className="pairing-review-imgbox">
            {item.ourImageUrl !== null ? (
              <img src={item.ourImageUrl} alt={item.productName} loading="lazy" />
            ) : (
              <span className="pairing-review-noimg">bez obrázka</span>
            )}
          </div>
        </div>

        <div className="pairing-review-side">
          <div className="pairing-review-label">Navrhnutý kandidát</div>
          {item.chosenCandidate === null ? (
            <p className="pairing-review-nocandidate" data-testid={`pairing-review-no-candidate-${item.productKey}`}>
              Nenašiel sa žiadny kandidát u dodávateľa.
            </p>
          ) : (
            <div data-testid={`pairing-review-candidate-${item.productKey}`}>
              <a
                className="pairing-review-name"
                href={item.chosenCandidate.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`pairing-review-candidate-link-${item.productKey}`}
              >
                {item.chosenCandidate.name}
              </a>
              <div className="pairing-review-meta">
                skóre {item.chosenCandidate.rawScore.toFixed(1)} · {CONFIDENCE_LABELS[item.confidence]}
                {item.chosenCandidate.codeHit && " · kód sedí"}
              </div>
              {item.verdict !== null && (
                <div className={"pairing-review-verdict pairing-review-verdict-" + item.verdict} data-testid={`pairing-review-verdict-${item.productKey}`}>
                  {VERDICT_LABELS[item.verdict]}
                </div>
              )}
            </div>
          )}
          <p className="pairing-review-placeholder">Rozhodovanie príde v ďalšej etape.</p>
        </div>
      </div>
    </div>
  );
}
