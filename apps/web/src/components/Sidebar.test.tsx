import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar.js";

const FOLDERS = [
  {
    id: "system",
    label: "Systém",
    tabs: [{ id: "sync", label: "Sync zo Shoptetu", icon: "🔄", Component: () => null }],
  },
  {
    id: "eshop",
    label: "Eshop",
    tabs: [{ id: "orders", label: "Na objednanie", icon: "📦", Component: () => null }],
  },
];

const ORIGINAL_INNER_WIDTH = window.innerWidth;

afterEach(() => {
  cleanup();
  // issue 190: zbalenie panela sa pamätá v `localStorage` — jsdom ho medzi
  // testami NEVYNULUJE, takže bez tohto by jeden test prepol stav všetkým
  // nasledujúcim.
  window.localStorage.clear();
  // issue 291: rovnaký dôvod pre `window.innerWidth` — testy nižšie ju menia
  // pred vykreslením, treba ju vrátiť na pôvodnú hodnotu pre ďalšie testy.
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: ORIGINAL_INNER_WIDTH });
});

it("vykreslí presne dva priečinky s jednou záložkou každý a označí aktívnu", () => {
  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} />);

  expect(screen.getByRole("button", { name: "Systém" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Eshop" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sync zo Shoptetu" }).className).toContain("active");
  expect(screen.getByRole("button", { name: "Na objednanie" }).className).not.toContain("active");
});

it("klik na záložku zavolá onSelectTab s jej id", () => {
  const onSelectTab = vi.fn();
  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={onSelectTab} />);

  fireEvent.click(screen.getByRole("button", { name: "Na objednanie" }));
  expect(onSelectTab).toHaveBeenCalledWith("orders");
});

// issue 343: šéf chce, aby "Systém" a "Automatizácie" štartovali ZBALENÉ
// (menu inak zaberá celú výšku a treba rolovať), "Eshop" ostáva rozbalený.
// Predvolený stav je deklarovaný PER PRIEČINOK v `nav.ts` (`defaultCollapsed`),
// nie ako zoznam mien v `Sidebar.tsx` — test preto simuluje presne tento tvar
// registra (tri priečinky, dva s `defaultCollapsed: true`).
const FOLDERS_WITH_DEFAULT_COLLAPSED = [
  {
    id: "eshop",
    label: "Eshop",
    tabs: [{ id: "orders", label: "Na objednanie", icon: "📦", Component: () => null }],
  },
  {
    id: "system",
    label: "Systém",
    defaultCollapsed: true,
    tabs: [{ id: "sync", label: "Sync zo Shoptetu", icon: "🔄", Component: () => null }],
  },
  {
    id: "automations",
    label: "Automatizácie",
    defaultCollapsed: true,
    tabs: [{ id: "restock", label: "Vypredané → Skladom", icon: "🔁", Component: () => null }],
  },
];

it("Systém a Automatizácie štartujú zbalené (defaultCollapsed), Eshop ostáva rozbalený", () => {
  render(<Sidebar folders={FOLDERS_WITH_DEFAULT_COLLAPSED} activeTabId="orders" onSelectTab={() => {}} />);

  expect(screen.getByRole("button", { name: "Eshop" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Systém" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("button", { name: "Automatizácie" }).getAttribute("aria-expanded")).toBe("false");
});

it("priečinok bez defaultCollapsed (napr. budúce Dôležité z #342) štartuje rozbalený ako doteraz", () => {
  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} />);

  expect(screen.getByRole("button", { name: "Systém" }).getAttribute("aria-expanded")).toBe("true");
});

it("klik na hlavičku priečinka ho zbalí (folder-chev sa otočí cez triedu 'collapsed')", () => {
  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} />);

  const folderBtn = screen.getByRole("button", { name: "Systém" });
  expect(folderBtn.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(folderBtn);
  expect(folderBtn.getAttribute("aria-expanded")).toBe("false");
});

// issue 147: `badgeCounts` je generický (kľúčovaný `tab.id`), nielen pre
// "Na objednanie" — test preto overuje aj že tab BEZ kľúča v `badgeCounts`
// odznak nedostane vôbec (nie odznak s "0").
it("vykreslí odznak len pre záložku s kľúčom v badgeCounts, ostatné bez odznaku", () => {
  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} badgeCounts={{ orders: 3 }} />);

  expect(screen.getByTestId("nav-badge-orders").textContent).toBe("3");
  expect(screen.queryByTestId("nav-badge-sync")).toBeNull();
});

it("bez badgeCounts (prop vôbec chýba) sa nevykreslí žiadny odznak", () => {
  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} />);

  expect(screen.queryByTestId("nav-badge-orders")).toBeNull();
});

// issue 185: `badgeStatus` je rovnaký generický vzor ako `badgeCounts` — over
// oba stavy ("on"/"off") aj že tab bez kľúča nedostane žiadny odznak.
it("vykreslí stav 'Beží' pre 'on', 'Zastavené' pre 'off', nič pre záložku bez kľúča v badgeStatus", () => {
  render(
    <Sidebar
      folders={FOLDERS}
      activeTabId="sync"
      onSelectTab={() => {}}
      badgeStatus={{ orders: "on", sync: "off" }}
    />,
  );

  const orders = screen.getByTestId("nav-status-orders");
  expect(orders.textContent).toBe("Beží");
  expect(orders.className).not.toContain("off");

  const sync = screen.getByTestId("nav-status-sync");
  expect(sync.textContent).toBe("Zastavené");
  expect(sync.className).toContain("off");
});

it("bez badgeStatus (prop vôbec chýba) sa nevykreslí žiadny stavový odznak", () => {
  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} />);

  expect(screen.queryByTestId("nav-status-orders")).toBeNull();
  expect(screen.queryByTestId("nav-status-sync")).toBeNull();
});

// issue 190: zbalenie CELÉHO panela do úzkej lišty. Zámerne sa overuje DOM
// dôsledok (názvy zmiznú, ikony ostanú, prístupný názov prežije), nie CSS
// šírka — tú vitest/jsdom nevykresľuje vôbec (živú šírku overuje e2e).
it("zbalenie panela skryje názvy záložiek aj hlavičky priečinkov, ikony ostanú", () => {
  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} />);

  const prepinac = screen.getByTestId("sidebar-rail-toggle");
  expect(prepinac.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Systém" })).toBeTruthy();

  fireEvent.click(prepinac);

  expect(prepinac.getAttribute("aria-expanded")).toBe("false");
  // Hlavičky priečinkov sa v lište nevykresľujú vôbec.
  expect(screen.queryByRole("button", { name: "Systém" })).toBeNull();
  // Záložka ostáva klikateľná a MÁ prístupný názov (z `aria-label`), hoci jej
  // viditeľný text je preč — inak by tlačidlo v lište bolo bezmenné.
  const zalozka = screen.getByRole("button", { name: "Na objednanie" });
  expect(zalozka.textContent).toBe("📦");
  expect(zalozka.getAttribute("title")).toBe("Na objednanie");
});

it("v zbalenom paneli nesie bublina aj stav automatizácie (pilulka sa tam nevykreslí)", () => {
  render(
    <Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} badgeStatus={{ orders: "off" }} />,
  );

  fireEvent.click(screen.getByTestId("sidebar-rail-toggle"));

  expect(screen.queryByTestId("nav-status-orders")).toBeNull();
  expect(screen.getByRole("button", { name: "Na objednanie — Zastavené" }).getAttribute("title")).toBe(
    "Na objednanie — Zastavené",
  );
});

it("záložka sa dá prepnúť aj v zbalenom paneli", () => {
  const onSelectTab = vi.fn();
  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={onSelectTab} />);

  fireEvent.click(screen.getByTestId("sidebar-rail-toggle"));
  fireEvent.click(screen.getByRole("button", { name: "Na objednanie" }));

  expect(onSelectTab).toHaveBeenCalledWith("orders");
});

it("voľba prežije obnovenie stránky (nové vykreslenie číta zapamätaný stav)", () => {
  const prve = render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} />);
  fireEvent.click(screen.getByTestId("sidebar-rail-toggle"));
  prve.unmount();

  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} />);

  expect(screen.getByTestId("sidebar-rail-toggle").getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Systém" })).toBeNull();
});

// Priečinok zbalený PRED zbalením panela nesmie v lište schovať svoje ikony —
// v tom stave sa hlavičky priečinkov nevykresľujú, takže by sa k záložkám už
// nedalo dostať.
it("priečinok zbalený pred zbalením panela nechá svoje ikony v lište viditeľné", () => {
  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} />);

  fireEvent.click(screen.getByRole("button", { name: "Systém" }));
  fireEvent.click(screen.getByTestId("sidebar-rail-toggle"));

  expect(screen.getByRole("button", { name: "Sync zo Shoptetu" })).toBeTruthy();
});

// issue 291: na úzkej (telefónnej) obrazovke sa panel PRVOTNE (pri prvom
// vykreslení, bez akéhokoľvek uloženého stavu) zbalí sám — na širokej
// (počítačovej) ostáva pôvodné rozbalené správanie. Nastavenie
// `window.innerWidth` pred vykreslením je jediný spôsob, ako v jsdom overiť
// "prvotný stav podľa šírky", keďže jsdom skutočný CSS layout nevykresľuje.
function setWindowInnerWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
}

it("na úzkej obrazovke (375px) sa panel bez uloženej voľby prvotne zbalí", () => {
  setWindowInnerWidth(375);

  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} />);

  expect(screen.getByTestId("sidebar-rail-toggle").getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Systém" })).toBeNull();
});

it("na širokej (počítačovej) obrazovke (1280px) sa panel bez uloženej voľby prvotne rozbalí", () => {
  setWindowInnerWidth(1280);

  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} />);

  expect(screen.getByTestId("sidebar-rail-toggle").getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Systém" })).toBeTruthy();
});

it("uložená voľba (užívateľ predtým panel ručne rozbalil) vyhráva aj na úzkej obrazovke", () => {
  window.localStorage.setItem("forestshop:sidebar-rail", "0");
  setWindowInnerWidth(375);

  render(<Sidebar folders={FOLDERS} activeTabId="sync" onSelectTab={() => {}} />);

  expect(screen.getByTestId("sidebar-rail-toggle").getAttribute("aria-expanded")).toBe("true");
});
