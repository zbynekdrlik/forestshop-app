import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RiesitSection } from "./RiesitSection.js";

afterEach(() => {
  cleanup();
});

it("vykreslí placeholder poznámku, že sa obrazovka pripravuje", () => {
  render(<RiesitSection />);
  const placeholder = screen.getByTestId("riesit-placeholder");
  expect(placeholder.textContent).toContain("pripravuje");
});

// `.claude/rules/frontend-design.md`: VIDITEĽNÁ záložka NESMIE mať vlastný
// `<h1>`/`<h2>` — titulok „Riešiť" renderuje `App.tsx` cez `Topbar`, vlastný
// nadpis by ho zduploval (`getByRole("heading")` by potom našiel 2 prvky).
it("nemá vlastný nadpis (Topbar ho renderuje za viditeľné záložky)", () => {
  render(<RiesitSection />);
  expect(screen.queryByRole("heading")).toBeNull();
});
