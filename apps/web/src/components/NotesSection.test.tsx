import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotesSection } from "./NotesSection.js";
import type { NoteRow } from "../notesApi.js";

const { fetchNotes, createNote, setNoteResolved, deleteNote } = vi.hoisted(() => ({
  fetchNotes: vi.fn(),
  createNote: vi.fn(),
  setNoteResolved: vi.fn(),
  deleteNote: vi.fn(),
}));

// `NotesUnauthorizedError` ostáva SKUTOČNÁ trieda — `instanceof` v komponente
// musí fungovať aj v teste (rovnaký dôvod ako `DpdSection.test.tsx`).
vi.mock("../notesApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../notesApi.js")>();
  return { ...actual, fetchNotes, createNote, setNoteResolved, deleteNote };
});

const { NotesUnauthorizedError } = await import("../notesApi.js");

function note(overrides: Partial<NoteRow> & Pick<NoteRow, "id" | "body">): NoteRow {
  return {
    authorUserId: "u-1",
    authorName: "Šéf",
    resolvedAt: null,
    createdAt: "2026-08-15T09:00:00Z",
    updatedAt: "2026-08-15T09:00:00Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("prázdny zoznam ukáže výzvu napísať prvú poznámku", async () => {
  fetchNotes.mockResolvedValue([]);
  render(<NotesSection onSessionExpired={() => {}} />);
  expect(await screen.findByTestId("poznamky-empty")).toBeDefined();
});

it(" zobrazí zdieľané poznámky s menom autora, najnovšie hore (v poradí zo servera)", async () => {
  fetchNotes.mockResolvedValue([
    note({ id: "n-2", body: "zavolať Záhoreckému", authorName: "Štěpán" }),
    note({ id: "n-1", body: "objednať sáčky", authorName: "Marek" }),
  ]);
  render(<NotesSection onSessionExpired={() => {}} />);

  expect((await screen.findByTestId("poznamka-body-n-2")).textContent).toBe("zavolať Záhoreckému");
  expect(screen.getByTestId("poznamka-meta-n-2").textContent).toContain("Štěpán");
  expect(screen.getByTestId("poznamka-body-n-1").textContent).toBe("objednať sáčky");
  expect(screen.getByTestId("poznamka-meta-n-1").textContent).toContain("Marek");
});

it("Uložiť je vypnuté pri prázdnom poli a zavolá createNote s orezaným textom", async () => {
  fetchNotes.mockResolvedValue([]);
  createNote.mockResolvedValue(undefined);
  render(<NotesSection onSessionExpired={() => {}} />);
  await screen.findByTestId("poznamky-empty");

  const save = screen.getByTestId<HTMLButtonElement>("poznamka-new-save");
  expect(save.disabled).toBe(true); // prázdne pole → vypnuté

  const input = screen.getByTestId<HTMLTextAreaElement>("poznamka-new-input");
  fireEvent.change(input, { target: { value: "  nový nápad  " } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);

  await waitFor(() => {
    expect(createNote).toHaveBeenCalledWith("nový nápad");
  });
});

it("checkbox vybaví poznámku — zavolá setNoteResolved(id, true)", async () => {
  fetchNotes.mockResolvedValue([note({ id: "n-1", body: "spracovať" })]);
  setNoteResolved.mockResolvedValue(true);
  render(<NotesSection onSessionExpired={() => {}} />);
  await screen.findByTestId("poznamka-row-n-1");

  fireEvent.click(screen.getByTestId("poznamka-resolve-n-1"));
  await waitFor(() => {
    expect(setNoteResolved).toHaveBeenCalledWith("n-1", true);
  });
});

it("vybavená poznámka OSTÁVA v zozname a je vizuálne stlmená (.done)", async () => {
  fetchNotes.mockResolvedValue([note({ id: "n-1", body: "hotové", resolvedAt: "2026-08-15T10:00:00Z" })]);
  render(<NotesSection onSessionExpired={() => {}} />);

  const row = await screen.findByTestId("poznamka-row-n-1");
  expect(row.className).toContain("done");
  const checkbox = screen.getByTestId<HTMLInputElement>("poznamka-resolve-n-1");
  expect(checkbox.checked).toBe(true);
});

it("kôš zmaže poznámku — zavolá deleteNote(id)", async () => {
  fetchNotes.mockResolvedValue([note({ id: "n-1", body: "zmazať" })]);
  deleteNote.mockResolvedValue(undefined);
  render(<NotesSection onSessionExpired={() => {}} />);
  await screen.findByTestId("poznamka-row-n-1");

  fireEvent.click(screen.getByTestId("poznamka-delete-n-1"));
  await waitFor(() => {
    expect(deleteNote).toHaveBeenCalledWith("n-1");
  });
});

it("vypršaná relácia (401) zavolá onSessionExpired", async () => {
  fetchNotes.mockRejectedValue(new NotesUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<NotesSection onSessionExpired={onSessionExpired} />);
  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalled();
  });
});
