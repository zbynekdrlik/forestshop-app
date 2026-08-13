import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FloorNotesSection } from "./FloorNotesSection.js";

const { fetchFloorNotes } = vi.hoisted(() => ({ fetchFloorNotes: vi.fn() }));
vi.mock("../floorNotesApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../floorNotesApi.js")>();
  return { ...actual, fetchFloorNotes };
});

const ROW = {
  id: "note-a",
  text: "zákazník chce bundu",
  resolved: false,
  ordered: false,
  called: false,
  createdAt: "2026-08-11T08:00:00.000Z",
  updatedAt: "2026-08-11T08:00:00.000Z",
  products: [{ variantCode: "40237/L", productName: "Bunda Rogaland", sizeLabel: "L", shopUrl: "https://www.forestshop.sk/bunda/" }],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// issue 410: zápis je gejtovaný `requireRole("admin","manazer")` na
// serveri (`floor-notes-routes.ts`) — UI pre "citanie" rolu preto skrýva
// KAŽDÝ interaktívny prvok, čítanie zoznamu ostáva viditeľné (rovnaký vzor
// ako `UpozorneniaSection.tsx`'s `CONTROL_ROLES`).
it("rola 'citanie' vidí zoznam a pripnuté produkty, ale žiadny zapisovací ovládací prvok", async () => {
  fetchFloorNotes.mockResolvedValueOnce([ROW]);
  render(<FloorNotesSection role="citanie" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-note-row-note-a");

  // Čítanie ostáva viditeľné.
  expect(screen.getByTestId("floor-note-text-note-a").textContent).toBe("zákazník chce bundu");
  expect(screen.getByTestId("floor-note-product-link-note-a-40237/L")).toBeTruthy();

  // Žiadny nový zápis.
  expect(screen.queryByTestId("floor-note-new-input")).toBeNull();
  // Značky ostávajú VIDITEĽNÉ (nesú informáciu o stave), ale sú disabled —
  // "citanie" ich nesmie prepnúť.
  expect(screen.getByTestId<HTMLButtonElement>("floor-note-marker-resolved-note-a").disabled).toBe(true);
  // Upraviť/zmazať/odopnúť/pripnúť sú plne SKRYTÉ (nesú žiadnu informačnú
  // hodnotu v disabled stave).
  expect(screen.queryByTestId("floor-note-edit-note-a")).toBeNull();
  expect(screen.queryByTestId("floor-note-delete-note-a")).toBeNull();
  expect(screen.queryByTestId("floor-note-product-detach-note-a-40237/L")).toBeNull();
  expect(screen.queryByTestId("floor-note-attach-toggle-note-a")).toBeNull();
});
