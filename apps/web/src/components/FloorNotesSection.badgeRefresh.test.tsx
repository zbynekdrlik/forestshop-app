import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FloorNotesBadgeRefreshContext } from "../floorNotesBadgeContext.js";
import { FloorNotesSection } from "./FloorNotesSection.js";

// issue 473: odznak počtu nevybavených zápisov v ľavom menu — `FloorNotesSection`
// musí po count-meniacej mutácii zavolať `refresh()` z
// `FloorNotesBadgeRefreshContext`. Count MENÍ len: pridanie, zmazanie a
// prepnutie ✅ vybavené (`resolved`). Značky 🛒 objednané / 📞 zavolané count
// NEMENIA — tie refresh NEvolajú (kľúčové rozlíšenie tohto testu, design
// komentár na issue 473).

const { fetchFloorNotes, createFloorNote, deleteFloorNote, setFloorNoteResolved, setFloorNoteOrdered } = vi.hoisted(() => ({
  fetchFloorNotes: vi.fn(),
  createFloorNote: vi.fn(),
  deleteFloorNote: vi.fn(),
  setFloorNoteResolved: vi.fn(),
  setFloorNoteOrdered: vi.fn(),
}));

vi.mock("../floorNotesApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../floorNotesApi.js")>();
  return { ...actual, fetchFloorNotes, createFloorNote, deleteFloorNote, setFloorNoteResolved, setFloorNoteOrdered };
});

const ZAPIS = {
  id: "note-1",
  text: "Matúš Dubec, 0949 647 802",
  resolved: false,
  ordered: false,
  called: false,
  createdAt: "2026-08-23T08:00:00.000Z",
  updatedAt: "2026-08-23T08:00:00.000Z",
  products: [],
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderWithRefresh(refresh: () => void) {
  render(
    <FloorNotesBadgeRefreshContext.Provider value={{ refresh }}>
      <FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />
    </FloorNotesBadgeRefreshContext.Provider>,
  );
}

it("pridanie zápisu zavolá refresh() (odznak sa refetchne bez zmeny záložky)", async () => {
  fetchFloorNotes.mockResolvedValueOnce([]).mockResolvedValueOnce([ZAPIS]);
  createFloorNote.mockResolvedValue(undefined);
  const refresh = vi.fn();
  renderWithRefresh(refresh);
  await screen.findByTestId("floor-notes-empty");
  expect(refresh).not.toHaveBeenCalled();

  fireEvent.change(screen.getByTestId("floor-note-new-input"), { target: { value: "Matúš Dubec, 0949 647 802" } });
  fireEvent.click(screen.getByTestId("floor-note-new-add"));

  await waitFor(() => {
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

it("prepnutie ✅ vybavené zavolá refresh()", async () => {
  fetchFloorNotes.mockResolvedValueOnce([ZAPIS]).mockResolvedValueOnce([{ ...ZAPIS, resolved: true }]);
  setFloorNoteResolved.mockResolvedValue(true);
  const refresh = vi.fn();
  renderWithRefresh(refresh);
  await screen.findByTestId("floor-note-row-note-1");
  expect(refresh).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("floor-note-marker-resolved-note-1"));

  await waitFor(() => {
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

it("zmazanie zápisu zavolá refresh()", async () => {
  fetchFloorNotes.mockResolvedValueOnce([ZAPIS]).mockResolvedValueOnce([]);
  deleteFloorNote.mockResolvedValue(true);
  const refresh = vi.fn();
  renderWithRefresh(refresh);
  await screen.findByTestId("floor-note-row-note-1");

  fireEvent.click(screen.getByTestId("floor-note-delete-note-1"));

  await waitFor(() => {
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

it("prepnutie 🛒 objednané NEZAVOLÁ refresh() (nevybavené = len ✅ resolved)", async () => {
  fetchFloorNotes.mockResolvedValue([ZAPIS]);
  setFloorNoteOrdered.mockResolvedValue(true);
  const refresh = vi.fn();
  renderWithRefresh(refresh);
  await screen.findByTestId("floor-note-row-note-1");

  fireEvent.click(screen.getByTestId("floor-note-marker-ordered-note-1"));

  await waitFor(() => {
    expect(setFloorNoteOrdered).toHaveBeenCalledTimes(1);
  });
  expect(refresh).not.toHaveBeenCalled();
});
