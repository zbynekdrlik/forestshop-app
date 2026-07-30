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
}: {
  readonly folders: readonly NavFolder[];
  readonly activeTabId: string;
  readonly onSelectTab: (id: string) => void;
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
                  {folder.tabs.map((tab) => (
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
                    </button>
                  ))}
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
