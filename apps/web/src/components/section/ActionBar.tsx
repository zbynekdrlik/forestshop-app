import type { JSX, ReactNode } from "react";

// issue 548 (PR D): zdieľaný akčný rad sekcie — tlačidlá `.btn sm` vedľa seba
// (`flex` + `flex-wrap` + `gap`), vytiahnutý z ad-hoc `.mt-actions`. Zjednocuje
// zblúdilé sekčné akčné rady s `btn lg` na jednotnú `btn sm` veľkosť (dominantný
// jazyk sekcií, viď „Na objednanie"). MODÁLNE akcie (`.modal-actions` —
// MailPreviewDialog, ThemeColorPicker) a zámerne prominentné PRIMÁRNE tlačidlo
// (DpdSection „Objednať zvoz", issue 451) NIE sú akčné rady sekcie a `lg` si
// vedome ponechávajú (viď komentár na issue 548).
//
// Čisto prezentačný obal: veľkosť/variant tlačidiel aj callbacky vlastní sekcia.
// `className` = voliteľná DODATOČNÁ trieda VEDĽA `.action-bar`.
export function ActionBar({
  testId,
  className,
  children,
}: {
  readonly testId?: string;
  readonly className?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const classes = ["action-bar", className].filter((c) => c !== undefined && c !== "").join(" ");
  return (
    <div className={classes} data-testid={testId}>
      {children}
    </div>
  );
}
