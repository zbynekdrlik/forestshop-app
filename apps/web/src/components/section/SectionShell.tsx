import type { JSX, ReactNode } from "react";

// issue 548 (PR A): zdieľaná kostra sekcie vytiahnutá zo vzoru „Na objednanie"
// (`OrdersSection.tsx` — `section.orders-section` + načítavací/`[role=alert]`/
// `p.empty` slot). Každá sekcia tak dostane rovnaký koreň a rovnaké stavové
// sloty, namiesto vlastného „pomiešaného" markupu (holý `<section>`/`<div>`,
// holý `<p>Načítavam…</p>`, skorý-return nahrádzajúci celú obrazovku).
//
// Čisto prezentačný obal: dáta, stav a rozhodnutie ČO renderovať ostávajú na
// sekcii — sem prídu len vlajky `loading`/`error` a `children`. `loading`
// a `children` sa renderujú SÚČASNE (ako vzor: dlaždice sa ukazujú aj počas
// načítania) — sekcia, ktorá chce načítanie „namiesto obsahu", jednoducho
// nepošle `children`, kým sa nenačíta.
export function SectionShell({
  className = "orders-section",
  testId,
  loading = false,
  loadingText = "Načítavam…",
  error = "",
  children,
}: {
  readonly className?: string;
  readonly testId?: string;
  readonly loading?: boolean;
  readonly loadingText?: string;
  readonly error?: string;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <section className={className} data-testid={testId}>
      {/* `role="status"` (a11y + e2e kontrakt), neutrálny vzhľad cez `.loading`
          (app.css) — žiadny zelený „success" box pre obyčajné načítavanie. */}
      {loading && (
        <p className="loading" role="status">
          {loadingText}
        </p>
      )}
      {error !== "" && <p role="alert">{error}</p>}
      {children}
    </section>
  );
}
