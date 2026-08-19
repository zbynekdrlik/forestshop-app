import type { JSX } from "react";

// issue 450 (šéfov kolega Štěpán, Discord 19.8.2026): „Pridať položku Riešiť
// pod Nedostupné tovary - jej funkciu - vymyslíme ako to bude vyzerať". Zatiaľ
// len placeholder — funkcia príde ako samostatné zadanie.
//
// VIDITEĽNÁ záložka (`nav.ts`, priečinok „eshop"), takže NEMÁ vlastný
// `<h1>`/`<h2>` — titulok „Riešiť" renderuje `App.tsx` cez `Topbar`
// (`isVisibleTabId`), vlastný nadpis by ho zduploval (`.claude/rules/
// frontend-design.md`, rovnaký vzor ako `OrdersSection`/`NedostupneSection`).
// Bez props (žiadne role-gating, žiadny fetch) — funkcia bez parametrov je
// priraditeľná na `ComponentType<SectionProps>` (App.tsx odovzdáva reálny
// SectionProps objekt, komponent ho jednoducho ignoruje).
export function RiesitSection(): JSX.Element {
  return (
    <section data-testid="riesit-section">
      <p className="empty" data-testid="riesit-placeholder">
        Táto obrazovka sa pripravuje 🤔 — jej funkciu ešte spoločne upresníme.
        Zatiaľ tu nič nie je.
      </p>
    </section>
  );
}
