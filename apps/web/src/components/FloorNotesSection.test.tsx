import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FloorNotesSection } from "./FloorNotesSection.js";

const {
  fetchFloorNotes,
  createFloorNote,
  updateFloorNoteText,
  setFloorNoteResolved,
  setFloorNoteOrdered,
  setFloorNoteCalled,
  deleteFloorNote,
} = vi.hoisted(() => ({
  fetchFloorNotes: vi.fn(),
  createFloorNote: vi.fn(),
  updateFloorNoteText: vi.fn(),
  setFloorNoteResolved: vi.fn(),
  setFloorNoteOrdered: vi.fn(),
  setFloorNoteCalled: vi.fn(),
  deleteFloorNote: vi.fn(),
}));

// `FloorNotesUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod ako
// `DailyTasksSection.test.tsx` — `instanceof` v komponente musí fungovať).
vi.mock("../floorNotesApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../floorNotesApi.js")>();
  return {
    ...actual,
    fetchFloorNotes,
    createFloorNote,
    updateFloorNoteText,
    setFloorNoteResolved,
    setFloorNoteOrdered,
    setFloorNoteCalled,
    deleteFloorNote,
  };
});

const ROW_A = {
  id: "note-a",
  text: "Matúš Dubec\n0949 647 802\nbunda Rogaland L",
  resolved: false,
  ordered: false,
  called: false,
  createdAt: "2026-08-11T08:00:00.000Z",
  updatedAt: "2026-08-11T08:00:00.000Z",
  products: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("zobrazí zoznam zápisov z fetchFloorNotes", async () => {
  fetchFloorNotes.mockResolvedValueOnce([ROW_A]);
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-note-row-note-a");
  expect(screen.getByTestId("floor-note-text-note-a").textContent).toContain("Matúš Dubec");
});

it("prázdny zoznam ukáže výzvu, nie chybu", async () => {
  fetchFloorNotes.mockResolvedValueOnce([]);
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-notes-empty");
});

it("Enter v novej textarei NEODOŠLE zápis — pridá sa len tlačidlom", async () => {
  fetchFloorNotes.mockResolvedValueOnce([]);
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-notes-empty");

  const textarea = screen.getByTestId<HTMLTextAreaElement>("floor-note-new-input");
  fireEvent.change(textarea, { target: { value: "riadok jedna" } });
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(createFloorNote).not.toHaveBeenCalled();
  expect(textarea.value).toBe("riadok jedna");
});

it("tlačidlo '+ Pridať zápis' vytvorí zápis a vyčistí pole", async () => {
  fetchFloorNotes.mockResolvedValueOnce([]).mockResolvedValueOnce([ROW_A]);
  createFloorNote.mockResolvedValueOnce(undefined);
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-notes-empty");

  const textarea = screen.getByTestId<HTMLTextAreaElement>("floor-note-new-input");
  fireEvent.change(textarea, { target: { value: "Matúš Dubec, 0949 647 802" } });
  fireEvent.click(screen.getByTestId("floor-note-new-add"));

  await waitFor(() => {
    expect(createFloorNote).toHaveBeenCalledWith("Matúš Dubec, 0949 647 802");
  });
  await screen.findByTestId("floor-note-row-note-a");
  expect(textarea.value).toBe("");
});

it("prázdny text sa neodošle (tlačidlo je disabled)", async () => {
  fetchFloorNotes.mockResolvedValueOnce([]);
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-notes-empty");
  expect(screen.getByTestId<HTMLButtonElement>("floor-note-new-add").disabled).toBe(true);
});

it("upraví text zápisu cez inline ✏️ toggle", async () => {
  fetchFloorNotes.mockResolvedValueOnce([ROW_A]).mockResolvedValueOnce([{ ...ROW_A, text: "nový text" }]);
  updateFloorNoteText.mockResolvedValueOnce(true);
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-note-row-note-a");

  fireEvent.click(screen.getByTestId("floor-note-edit-note-a"));
  const editInput = screen.getByTestId<HTMLTextAreaElement>("floor-note-edit-input-note-a");
  fireEvent.change(editInput, { target: { value: "nový text" } });
  fireEvent.click(screen.getByTestId("floor-note-edit-save-note-a"));

  await waitFor(() => {
    expect(updateFloorNoteText).toHaveBeenCalledWith("note-a", "nový text");
  });
  await waitFor(() => {
    expect(screen.getByTestId("floor-note-text-note-a").textContent).toBe("nový text");
  });
});

it("tri značky sú NEZÁVISLÉ prepínače — každá volá svoju vlastnú akciu", async () => {
  fetchFloorNotes.mockResolvedValue([ROW_A]);
  setFloorNoteResolved.mockResolvedValueOnce(true);
  setFloorNoteOrdered.mockResolvedValueOnce(true);
  setFloorNoteCalled.mockResolvedValueOnce(true);
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-note-row-note-a");

  fireEvent.click(screen.getByTestId("floor-note-marker-resolved-note-a"));
  await waitFor(() => {
    expect(setFloorNoteResolved).toHaveBeenCalledWith("note-a", true);
  });

  fireEvent.click(screen.getByTestId("floor-note-marker-ordered-note-a"));
  await waitFor(() => {
    expect(setFloorNoteOrdered).toHaveBeenCalledWith("note-a", true);
  });

  fireEvent.click(screen.getByTestId("floor-note-marker-called-note-a"));
  await waitFor(() => {
    expect(setFloorNoteCalled).toHaveBeenCalledWith("note-a", true);
  });
});

it("vybavený zápis OSTÁVA v zozname (nezmizne), len je stlmený", async () => {
  fetchFloorNotes.mockResolvedValueOnce([{ ...ROW_A, resolved: true }]);
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-note-row-note-a");
  expect(screen.getByTestId("floor-note-row-note-a").className).toContain("floor-note-resolved");
});

it("odstráni zápis okamžite, bez potvrdzovacieho dialógu", async () => {
  fetchFloorNotes.mockResolvedValueOnce([ROW_A]).mockResolvedValueOnce([]);
  deleteFloorNote.mockResolvedValueOnce(true);
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-note-row-note-a");

  fireEvent.click(screen.getByTestId("floor-note-delete-note-a"));

  await waitFor(() => {
    expect(deleteFloorNote).toHaveBeenCalledWith("note-a");
  });
  await screen.findByTestId("floor-notes-empty");
});

it("pri 401 (session vypršala) zavolá onSessionExpired", async () => {
  const { FloorNotesUnauthorizedError } = await import("../floorNotesApi.js");
  fetchFloorNotes.mockRejectedValueOnce(new FloorNotesUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<FloorNotesSection role="manazer" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalled();
  });
});

it("pri 401 POČAS mutácie (nielen počiatočného načítania) tiež zavolá onSessionExpired", async () => {
  const { FloorNotesUnauthorizedError } = await import("../floorNotesApi.js");
  fetchFloorNotes.mockResolvedValueOnce([ROW_A]);
  setFloorNoteResolved.mockRejectedValueOnce(new FloorNotesUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<FloorNotesSection role="manazer" onSessionExpired={onSessionExpired} />);
  await screen.findByTestId("floor-note-row-note-a");

  fireEvent.click(screen.getByTestId("floor-note-marker-resolved-note-a"));

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalled();
  });
});
