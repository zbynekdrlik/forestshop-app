import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Topbar } from "./Topbar.js";

afterEach(() => {
  cleanup();
});

function renderTopbar(overrides: {
  readonly title?: string | null;
  readonly onLogout?: () => void;
  readonly passwordPanelOpen?: boolean;
  readonly onTogglePasswordPanel?: () => void;
} = {}): void {
  render(
    <Topbar
      title={overrides.title === undefined ? "Sync zo Shoptetu" : overrides.title}
      greeting="Prihlásený: E2E Manažér (manazer)"
      onLogout={overrides.onLogout ?? (() => {})}
      passwordPanelOpen={overrides.passwordPanelOpen ?? false}
      onTogglePasswordPanel={overrides.onTogglePasswordPanel ?? (() => {})}
    >
      <p>Formulár zmeny hesla</p>
    </Topbar>,
  );
}

it("s titulkom zobrazí <h1> s daným textom", () => {
  renderTopbar({ title: "Sync zo Shoptetu" });
  expect(screen.getByRole("heading", { name: "Sync zo Shoptetu", level: 1 })).toBeTruthy();
});

// Skryté obrazovky (katalóg/párovanie/plánovač) si držia svoj vlastný <h2> —
// Topbar preto s `title: null` žiadny <h1> nevykreslí (predišlo by sa
// duplicitnému nadpisu s rovnakým textom).
it("s title=null nevykreslí žiadny nadpis", () => {
  renderTopbar({ title: null });
  expect(screen.queryByRole("heading")).toBeNull();
});

// Issue 57: zmena hesla/odhlásenie žijú v menu používateľa v hlavičke —
// zatvorené predvolene, otvorí sa klikom na meno.
it("zobrazí meno prihláseného používateľa, menu je predvolene zatvorené", () => {
  renderTopbar();
  expect(screen.getByTestId("greeting").textContent).toBe("Prihlásený: E2E Manažér (manazer)");
  expect(screen.queryByRole("button", { name: "Odhlásiť" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Zmeniť heslo" })).toBeNull();
});

it("klik na meno rozbalí menu s tlačidlami Zmeniť heslo a Odhlásiť", () => {
  renderTopbar();
  fireEvent.click(screen.getByTestId("greeting"));
  expect(screen.getByRole("button", { name: "Zmeniť heslo" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Odhlásiť" })).toBeTruthy();
});

it("klik na Odhlásiť (po rozbalení menu) zavolá onLogout", () => {
  const onLogout = vi.fn();
  renderTopbar({ onLogout });
  fireEvent.click(screen.getByTestId("greeting"));
  fireEvent.click(screen.getByRole("button", { name: "Odhlásiť" }));
  expect(onLogout).toHaveBeenCalledTimes(1);
});

it("keď je passwordPanelOpen, zobrazí children (napr. formulár zmeny hesla)", () => {
  renderTopbar({ passwordPanelOpen: true });
  fireEvent.click(screen.getByTestId("greeting"));
  expect(screen.getByText("Formulár zmeny hesla")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Zavrieť zmenu hesla" })).toBeTruthy();
});

it("keď passwordPanelOpen=false, children sa nevykreslia a tlačidlo hovorí 'Zmeniť heslo'", () => {
  renderTopbar({ passwordPanelOpen: false });
  fireEvent.click(screen.getByTestId("greeting"));
  expect(screen.queryByText("Formulár zmeny hesla")).toBeNull();
  expect(screen.getByRole("button", { name: "Zmeniť heslo" })).toBeTruthy();
});
