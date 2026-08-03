import { useState, type JSX } from "react";
import type { NavFolder } from "../nav.js";
import { Footer } from "./Footer.js";

// Ľavé menu — vlastný dizajn appky (issue 57): značka hore, priečinky so
// záložkami, päta len s verziou. Prihlásený používateľ/odhlásenie/zmena hesla
// žijú v hlavičke (`Topbar.tsx`'s používateľské menu), nie tu — to je
// dizajnové rozhodnutie zadania #57 ("user menu in the header"), nie
// prevzatie zo starej appky (tá menu v hlavičke vôbec nemá). Skladanie
// priečinkov (`collapsed`) je čisto prezentačné, preto žije tu — App.tsx si
// drží len AKTÍVNU záložku.
export function Sidebar({
  folders,
  activeTabId,
  onSelectTab,
  badgeCounts,
  badgeStatus,
}: {
  readonly folders: readonly NavFolder[];
  readonly activeTabId: string;
  readonly onSelectTab: (id: string) => void;
  // issue 147: voliteľný odznak (počet) per záložka, kľúčovaný `tab.id` — dnes
  // ho posiela len "Na objednanie" (`App.tsx`), ale Sidebar zostáva generický,
  // aby AKÁKOĽVEK budúca záložka mohla dostať odznak bez zásahu sem. Chýbajúci
  // kľúč = žiadny odznak (nie "0" — appka ešte nevie, nie "isté nula").
  readonly badgeCounts?: Readonly<Record<string, number>>;
  // issue 185: voliteľný stav zapnuté/vypnuté per záložka, rovnaký generický
  // vzor ako `badgeCounts` vyššie — dnes ho posiela `App.tsx` pre
  // "posta-uncollected"/"order-reminder" (jediné dve automatizácie, ktoré
  // majú Štart/Stop). Chýbajúci kľúč = žiadny odznak (napr. "nedostupne" —
  // tá nemá koncept zapnuté/vypnuté vôbec, je len na požiadanie).
  readonly badgeStatus?: Readonly<Record<string, "on" | "off">>;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({});

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          🌲
        </span>
        <span className="brandtxt">
          Forestshop
          <small>Firemný systém</small>
        </span>
      </div>
      <nav className="side-nav">
        {folders.map((folder) => {
          const isCollapsed = collapsed[folder.id] === true;
          return (
            <div className={"nav-folder" + (isCollapsed ? " collapsed" : "")} key={folder.id}>
              <button
                type="button"
                className="folder-head"
                aria-expanded={!isCollapsed}
                onClick={() => {
                  setCollapsed((c) => ({ ...c, [folder.id]: !isCollapsed }));
                }}
              >
                <span className="ftitle">{folder.label}</span>
                <span className="folder-chev" aria-hidden="true">
                  ⌄
                </span>
              </button>
              <div className="folder-body">
                <div className="tabs">
                  {folder.tabs.map((tab) => {
                    const badgeCount = badgeCounts?.[tab.id];
                    const status = badgeStatus?.[tab.id];
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        className={"tab" + (tab.id === activeTabId ? " active" : "")}
                        aria-current={tab.id === activeTabId ? "page" : undefined}
                        onClick={() => {
                          onSelectTab(tab.id);
                        }}
                      >
                        <span className="tlabel">{tab.label}</span>
                        {status !== undefined && (
                          // issue 185: rovnaký vizuál aj slovník ("Beží"/
                          // "Zastavené") ako `.pill` vnútri
                          // PostaUncollectedSection/OrderReminderSection —
                          // žiadny nový vzor navyše, len znovupoužitá trieda.
                          <span
                            className={"pill tab-status" + (status === "off" ? " off" : "")}
                            data-testid={`nav-status-${tab.id}`}
                          >
                            {status === "on" ? "Beží" : "Zastavené"}
                          </span>
                        )}
                        {badgeCount !== undefined && (
                          // Code review (PR 154): `aria-label` NESMIE niesť
                          // doménovo špecifické slovo ("nevybavených") — táto
                          // komponenta je zámerne generická pre AKÚKOĽVEK
                          // budúcu záložku (viď `badgeCounts` prop vyššie),
                          // takže popis smie použiť len to, čo Sidebar sám
                          // pozná: číslo + názov TEJTO záložky.
                          <span
                            className="tab-badge"
                            data-testid={`nav-badge-${tab.id}`}
                            aria-label={`${tab.label}: ${String(badgeCount)}`}
                          >
                            {badgeCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </nav>
      <div className="sidefoot">
        <div className="ver">
          verzia <Footer />
        </div>
      </div>
    </aside>
  );
}
