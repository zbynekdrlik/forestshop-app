import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar.js";

const FOLDERS = [
  { id: "system", label: "Systém", tabs: [{ id: "sync", label: "Sync zo Shoptetu", Component: () => null }] },
  { id: "eshop", label: "Eshop", tabs: [{ id: "orders", label: "Na objednanie", Component: () => null }] },
];

afterEach(() => {
  cleanup();
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
