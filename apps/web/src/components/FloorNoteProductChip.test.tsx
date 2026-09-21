import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FloorNoteProductChip } from "./FloorNoteProductChip.js";
import type { FloorNoteProduct } from "../floorNotesApi.js";

// `@testing-library/jest-dom` NIE je v tomto projekte zapojené
// (`.claude/rules/frontend-design.md`) — používame holé DOM asserty.
afterEach(() => {
  cleanup();
});

const NOTE_ID = "note-579";
const base: FloorNoteProduct = {
  variantCode: "40237/L",
  productName: "Bunda Rogaland",
  sizeLabel: "L",
  quantity: 2,
  shopUrl: "https://www.forestshop.sk/bunda/",
  state: "objednane",
  comment: null,
};

function renderChip(state: FloorNoteProduct["state"]): void {
  render(
    <FloorNoteProductChip
      product={{ ...base, state }}
      noteId={NOTE_ID}
      busy={false}
      canEdit={false}
      onDetach={vi.fn()}
      onUpdateQuantity={vi.fn()}
    />,
  );
}

const TEST_ID = `floor-note-product-state-${NOTE_ID}-${base.variantCode}`;

// issue 579 (Štěpán): „Nemáme“ (objednane) sa teraz zobrazuje ČERVENÝM odznakom
// (predtým sa pri objednane odznak vôbec nekreslil, keďže to bol default).
// Červená je vyjadrená modifikátorom `objednane` (`.pill.objednane` →
// `--fs-danger`), nie novým raw hex.
it("issue 579: „Nemáme“ (objednane) sa zobrazuje ako červený odznak", () => {
  renderChip("objednane");
  const chip = screen.getByTestId(TEST_ID);
  expect(chip.textContent).toBe("Nemáme");
  expect(chip.className.split(" ")).toContain("objednane");
});

// issue 579: NULL = neoznačený stav → žiadny odznak (rovnako ako predtým default).
it("issue 579: pri NULL stave sa odznak nekreslí", () => {
  renderChip(null);
  expect(screen.queryByTestId(TEST_ID)).toBeNull();
});

it("issue 579: iný stav (skladom) sa zobrazuje bez červeného modifikátora", () => {
  renderChip("skladom");
  const chip = screen.getByTestId(TEST_ID);
  expect(chip.textContent).toBe("Skladom");
  expect(chip.className.split(" ")).not.toContain("objednane");
});
