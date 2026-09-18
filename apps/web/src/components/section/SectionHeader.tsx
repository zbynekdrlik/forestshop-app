import type { JSX, ReactNode } from "react";

// issue 548 (PR A): zdieľaná hlavička sekcie (bez titulu — titul kreslí Topbar)
// vytiahnutá zo vzoru „Na objednanie" (`OrdersToolbar.tsx`): `.orders-toolbar`
// obal → voliteľný `.chip-row` s filtrami + voliteľný riadok súhrnu
// (`.orders-summary` + pravé akcie). DOM je BYTE-IDENTICKÝ s pôvodným
// `OrdersToolbar` markupom, keď sú všetky sloty vyplnené — refaktor vzoru je
// preto bez vizuálnej zmeny (yardstick). Čisto prezentačný: hodnoty aj
// callbacky vlastní sekcia.
export function SectionHeader({
  testId,
  filters,
  summary,
  summaryTestId,
  actions,
}: {
  readonly testId?: string;
  readonly filters?: ReactNode;
  readonly summary?: ReactNode;
  readonly summaryTestId?: string;
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="orders-toolbar" data-testid={testId}>
      {filters !== undefined && <div className="chip-row">{filters}</div>}
      {(summary !== undefined || actions !== undefined) && (
        <div className="orders-toolbar-summary-row">
          {summary !== undefined && (
            <p className="orders-summary" data-testid={summaryTestId}>
              {summary}
            </p>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}
