import type { JSX } from "react";

// issue 531: checkbox „vyriešené" pri karte produktu — vyčlenené z
// `NedostupneSection.tsx` (eslint `max-lines`), rovnaká extrakčná disciplína
// ako `NedostupneOrderNote`. Čisto prezentačné: stav (`resolved`/`disabled`)
// aj optimistický toggle žijú v rodičovi (`useNedostupneResolved`).
export function NedostupneResolvedCheckbox({
  variantCode,
  itemLabel,
  resolved,
  disabled,
  onToggle,
}: {
  readonly variantCode: string;
  readonly itemLabel: string;
  readonly resolved: boolean;
  readonly disabled: boolean;
  readonly onToggle: (variantCode: string, resolved: boolean) => void;
}): JSX.Element {
  return (
    <input
      type="checkbox"
      className="nedostupne-resolved-checkbox"
      data-testid={`nedostupne-resolved-checkbox-${variantCode}`}
      aria-label={`Označiť ${itemLabel} ako vyriešené`}
      title="Vyriešené"
      checked={resolved}
      disabled={disabled}
      onChange={(e) => {
        onToggle(variantCode, e.target.checked);
      }}
    />
  );
}
