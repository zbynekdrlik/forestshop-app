import type { JSX, ReactNode } from "react";

// issue 548 (PR C): jedno zdieľané ikonové tlačidlo (bez textu) vytiahnuté zo
// vzoru — zjednocuje dnešné klony `.uloha-icon-btn`, `.floor-note-icon-btn`,
// `.uhrady-note-delete` (a v PR D `.poznamka-icon-btn`) do jednej triedy
// `.icon-btn` (bez pozadia/rámu, `--fs-text-sm`, hover `--fs-surface-alt`).
// Čisto prezentačné: `type="button"`, správanie/callbacky vlastní sekcia.
//
// `className` = voliteľná DODATOČNÁ trieda VEDĽA `.icon-btn` na pozíciu
// (napr. legacy `floor-note-icon-btn` = `flex:0 0 auto`), nikdy nenahrádza
// vzhľad. Zámerne sa legacy triedy neodstraňujú z elementov — ostávajú ako
// neutrálne pozíciové háčiky, aby sa nič nepremenovalo.
export function IconButton({
  onClick,
  disabled = false,
  title,
  ariaLabel,
  ariaPressed,
  testId,
  className,
  children,
}: {
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly ariaPressed?: boolean;
  readonly testId?: string;
  readonly className?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const classes = ["icon-btn", className].filter((c) => c !== undefined && c !== "").join(" ");
  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
