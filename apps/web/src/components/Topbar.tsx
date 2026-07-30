import { useState, type JSX, type ReactNode } from "react";

// Horná lišta — vlastný titulok obrazovky (vľavo) + používateľské menu
// (vpravo). `title === null` pre SKRYTÉ obrazovky (katalóg/párovanie/
// plánovač, `nav.ts`'s `isVisibleTabId`) — tie si držia svoj PÔVODNÝ vlastný
// `<h2>` nadpis, takže Topbar tu žiadny druhý nepridáva (predišlo by sa tak
// duplicitnému nadpisu s rovnakým textom, na ktorý mieria ich existujúce e2e).
//
// Prihlásený používateľ/odhlásenie/zmena hesla žijú TU, nie v ľavom menu
// (issue 57 zadanie: "zmena hesla musí zostať dostupná — napr. cez menu
// používateľa v hlavičke") — klik na meno rozbalí/zabalí panel s "Zmeniť
// heslo"/"Odhlásiť". `menuOpen` je čisto prezentačné (Topbar si ho drží
// sám), `passwordPanelOpen` je zdvihnuté do App.tsx (rozhoduje, či sa
// vykresľuje `ChangePasswordForm` odovzdaný cez `children`).
export function Topbar({
  title,
  greeting,
  onLogout,
  passwordPanelOpen,
  onTogglePasswordPanel,
  children,
}: {
  readonly title: string | null;
  // "Prihlásený: <meno> (<rola>)" — `data-testid="greeting"`, overované e2e testami.
  readonly greeting: string;
  readonly onLogout: () => void;
  readonly passwordPanelOpen: boolean;
  readonly onTogglePasswordPanel: () => void;
  readonly children?: ReactNode;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="topbar">
      <div className="topbar-head">{title !== null && <h1>{title}</h1>}</div>
      <div className="topbar-user">
        <button
          type="button"
          className="usermenu-btn"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((open) => !open);
          }}
        >
          <span data-testid="greeting">{greeting}</span>
          <span className="usermenu-chev" aria-hidden="true">
            ⌄
          </span>
        </button>
        {menuOpen && (
          <div className="usermenu-panel">
            <button
              type="button"
              className="pwbtn"
              aria-pressed={passwordPanelOpen}
              onClick={onTogglePasswordPanel}
            >
              {passwordPanelOpen ? "Zavrieť zmenu hesla" : "Zmeniť heslo"}
            </button>
            {passwordPanelOpen && <div className="pwpanel">{children}</div>}
            <button type="button" className="logoutbtn" title="Odhlásiť sa" onClick={onLogout}>
              Odhlásiť
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
