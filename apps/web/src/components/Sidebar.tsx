import { useEffect, useState, type JSX } from "react";
import type { NavFolder } from "../nav.js";
import { Footer } from "./Footer.js";

// issue 190: zapamätaný stav zbaleného panela. `localStorage` môže v niektorých
// režimoch prehliadača hodiť výnimku (zakázané úložisko) — obe strany sú preto
// v `try`, s "rozbalený" ako bezpečným východiskom. Kľúč je zámerne
// prefixovaný názvom appky, na doméne bežia aj iné projekty.
const RAIL_KEY = "forestshop:sidebar-rail";

// issue 291: pod touto šírkou sa panel PRVOTNE zbalí sám (telefón) — nad ňou
// (tablet/počítač) zostáva pôvodné správanie (rozbalený). Toto je len
// PRVOTNÝ (na mount) predvolený stav; nejde o živú reakciu na zmenu šírky
// okna počas behu appky (mimo dohodnutého rozsahu ticketu).
const NARROW_VIEWPORT_MAX_WIDTH = 640;

function readStoredRail(): boolean | null {
  try {
    const v = window.localStorage.getItem(RAIL_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function isNarrowViewport(): boolean {
  try {
    return window.innerWidth <= NARROW_VIEWPORT_MAX_WIDTH;
  } catch {
    return false;
  }
}

// issue 291: ak už appka na tomto zariadení niekedy uložila výslovnú voľbu
// (užívateľ panel ručne prepol), tá VŽDY vyhráva — širka obrazovky sa berie
// do úvahy LEN keď žiadna uložená voľba ešte neexistuje.
function initialRail(): boolean {
  const stored = readStoredRail();
  return stored ?? isNarrowViewport();
}

// Ľavé menu — vlastný dizajn appky (issue 57): značka hore, priečinky so
// záložkami, päta len s verziou. Prihlásený používateľ/odhlásenie/zmena hesla
// žijú v hlavičke (`Topbar.tsx`'s používateľské menu), nie tu — to je
// dizajnové rozhodnutie zadania #57 ("user menu in the header"), nie
// prevzatie zo starej appky (tá menu v hlavičke vôbec nemá). Skladanie
// priečinkov (`collapsed`) aj zbalenie CELÉHO panela do úzkej lišty
// (`rail`, issue 190) sú čisto prezentačné, preto žijú tu — App.tsx si
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
  // issue 343: predvolený stav zbalenia sa číta z registra (`NavFolder
  // .defaultCollapsed` v `nav.ts`), nie hardcoded tu — pridanie nového
  // priečinka do menu tak nikdy nevyžaduje zásah do tejto komponenty. Lazy
  // initializer beží len pri prvom vykreslení (rovnaké `folders` prop sa
  // odovzdáva zo statického registra, nemení sa počas behu appky) — ZÁMERNE
  // sa NEPAMÄTÁ medzi návštevami (na rozdiel od `rail` nižšie), po obnovení
  // stránky sa vždy vráti na túto predvolenú hodnotu (viď dizajnové
  // rozhodnutie na tickete #343).
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>(() => {
    const initial: Record<string, boolean> = {};
    for (const folder of folders) {
      if (folder.defaultCollapsed === true) initial[folder.id] = true;
    }
    return initial;
  });
  const [rail, setRail] = useState<boolean>(initialRail);

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_KEY, rail ? "1" : "0");
    } catch {
      // Zakázané úložisko — voľba potom neprežije obnovenie stránky, ale
      // panel musí fungovať ďalej; nikdy nezhadzuj appku kvôli preferencii.
    }
  }, [rail]);

  const railToggleLabel = rail ? "Rozbaliť bočné menu" : "Zbaliť bočné menu";

  return (
    <aside className={"sidebar" + (rail ? " sidebar-rail" : "")}>
      <div className="brand">
        <span className="logo" aria-hidden="true">
          🌲
        </span>
        {!rail && (
          <span className="brandtxt">
            Forestshop
            <small>Firemný systém</small>
          </span>
        )}
      </div>
      {/* issue 190: prepínač má VŽDY rovnaký prístupný názov (`aria-label`),
          aj keď je jeho text v zbalenom stave skrytý — inak by sa tlačidlo v
          lište stalo bezmenným. `title` dáva ten istý text ako bublinu myšou. */}
      <button
        type="button"
        className="rail-toggle"
        data-testid="sidebar-rail-toggle"
        aria-expanded={!rail}
        aria-label={railToggleLabel}
        title={railToggleLabel}
        onClick={() => {
          setRail((r) => !r);
        }}
      >
        <span className="rail-toggle-icon" aria-hidden="true">
          {rail ? "»" : "«"}
        </span>
        {!rail && <span className="rail-toggle-label">Zbaliť menu</span>}
      </button>
      <nav className="side-nav">
        {folders.map((folder) => {
          // V zbalenej lište sa hlavičky priečinkov nevykresľujú vôbec (nemajú
          // ikonu ani miesto na text), takže ani ich vlastné skladanie nesmie
          // schovať záložky — preto sa trieda `collapsed` v tomto stave
          // neaplikuje. Po rozbalení panela sa pôvodný stav priečinkov vráti.
          const isCollapsed = !rail && collapsed[folder.id] === true;
          // issue 343 (code review nález): zbalenie priečinka skrylo odznaky/
          // pilulky, ktoré predtým (#331/#267) žiadali byť vidno HNEĎ po
          // prihlásení bez otvorenia záložky. Súhrn sa počíta LEN kým je
          // priečinok zbalený (po rozbalení sú vidno originály vnútri, žiadna
          // duplicita) — z tých istých `badgeCounts`/`badgeStatus` props, žiadny
          // nový sieťový dotaz. `aria-hidden` na oboch, aby hlavička priečinka
          // NEMENILA svoj prístupný názov (existujúce `getByRole("button",
          // {name: folder.label})` dotazy naprieč testami by inak prestali
          // sedieť, keďže by doň spadol aj text/aria-label odznaku).
          const folderBadgeSum = isCollapsed
            ? folder.tabs.reduce((sum, tab) => sum + (badgeCounts?.[tab.id] ?? 0), 0)
            : 0;
          const folderHasStatus =
            isCollapsed && folder.tabs.some((tab) => badgeStatus?.[tab.id] !== undefined);
          return (
            <div className={"nav-folder" + (isCollapsed ? " collapsed" : "")} key={folder.id}>
              {!rail && (
                <button
                  type="button"
                  className="folder-head"
                  aria-expanded={!isCollapsed}
                  onClick={() => {
                    setCollapsed((c) => ({ ...c, [folder.id]: !isCollapsed }));
                  }}
                >
                  <span className="ftitle">{folder.label}</span>
                  {folderBadgeSum > 0 && (
                    <span className="tab-badge" data-testid={`folder-badge-${folder.id}`} aria-hidden="true">
                      {folderBadgeSum}
                    </span>
                  )}
                  {folderBadgeSum === 0 && folderHasStatus && (
                    <span className="folder-dot" data-testid={`folder-dot-${folder.id}`} aria-hidden="true" />
                  )}
                  <span className="folder-chev" aria-hidden="true">
                    ⌄
                  </span>
                </button>
              )}
              <div className="folder-body">
                <div className="tabs">
                  {folder.tabs.map((tab) => {
                    const badgeCount = badgeCounts?.[tab.id];
                    const status = badgeStatus?.[tab.id];
                    // V zbalenej lište nesie bublina/prístupný názov aj stav
                    // automatizácie — pilulka "Beží"/"Zastavené" sa tam pre
                    // nedostatok miesta nevykresľuje, tá informácia by sa
                    // inak stratila úplne.
                    const railLabel =
                      status === undefined
                        ? tab.label
                        : `${tab.label} — ${status === "on" ? "Beží" : "Zastavené"}`;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        className={"tab" + (tab.id === activeTabId ? " active" : "")}
                        aria-current={tab.id === activeTabId ? "page" : undefined}
                        aria-label={rail ? railLabel : undefined}
                        title={rail ? railLabel : undefined}
                        onClick={() => {
                          onSelectTab(tab.id);
                        }}
                      >
                        <span className="ticon" aria-hidden="true">
                          {tab.icon}
                        </span>
                        {!rail && <span className="tlabel">{tab.label}</span>}
                        {!rail && status !== undefined && (
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
          {rail ? null : "verzia "}
          <Footer />
        </div>
      </div>
    </aside>
  );
}
