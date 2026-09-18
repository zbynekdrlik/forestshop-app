import type { JSX, ReactNode } from "react";

// issue 548 (PR A): jeden zdieľaný nosič „bublinkových" stavov/odznakov/počítadiel
// vytiahnutý zo vzoru — zjednocuje dnešné 4 jazyky (`.chip`, `.pill`,
// `.upozornenia-tab`, `.floor-note-marker`). PR A ho používa pre READ-ONLY
// odznaky/počítadlá (`OrderFlagTable` „nevybavené" pill, počítadlá
// Dodávateľského skladu); interaktívne filtre a stavové tlačidlá sa naň
// napoja v PR B/C.
//
// `base` = základná trieda (`chip` alebo `pill`), `modifier` = voliteľný
// modifikátor VEDĽA nej (napr. `chip-neutral`, `done`, `active`, `off`) —
// zámerne sa nemenuje/nemapuje, aby existujúce e2e CSS lokátory (`.chip`,
// `.pill`) ostali nedotknuté. `as="span"` (predvolené) = read-only odznak.
export function StateChip({
  base = "chip",
  modifier,
  className,
  testId,
  title,
  children,
}: {
  readonly base?: "chip" | "pill";
  readonly modifier?: string;
  readonly className?: string;
  readonly testId?: string;
  readonly title?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const classes = [base, modifier, className].filter((c) => c !== undefined && c !== "").join(" ");
  return (
    <span className={classes} data-testid={testId} title={title}>
      {children}
    </span>
  );
}
