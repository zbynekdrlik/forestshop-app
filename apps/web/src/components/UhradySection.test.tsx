import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UhradySection } from "./UhradySection.js";
import type { PaymentNoteRow, PaymentScanRow } from "../uhradyApi.js";

const { fetchPaymentNotes, createPaymentNote, deletePaymentNote, fetchPaymentScans, createPaymentScan, updatePaymentScanDescription, deletePaymentScan } = vi.hoisted(() => ({
  fetchPaymentNotes: vi.fn(),
  createPaymentNote: vi.fn(),
  deletePaymentNote: vi.fn(),
  fetchPaymentScans: vi.fn(),
  createPaymentScan: vi.fn(),
  updatePaymentScanDescription: vi.fn(),
  deletePaymentScan: vi.fn(),
}));

// `UhradyUnauthorizedError` + `uhradyScanImageUrl` ostávajú SKUTOČNÉ (instanceof
// v komponente / čistá URL funkcia) — rovnaký vzor ako `NotesSection.test.tsx`.
vi.mock("../uhradyApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../uhradyApi.js")>();
  return { ...actual, fetchPaymentNotes, createPaymentNote, deletePaymentNote, fetchPaymentScans, createPaymentScan, updatePaymentScanDescription, deletePaymentScan };
});

function noteRow(overrides: Partial<PaymentNoteRow> & Pick<PaymentNoteRow, "id" | "text">): PaymentNoteRow {
  return { authorUserId: "u-1", authorName: "Šéf", createdAt: "2026-09-01T09:00:00Z", updatedAt: "2026-09-01T09:00:00Z", ...overrides };
}
function scanRow(overrides: Partial<PaymentScanRow> & Pick<PaymentScanRow, "id">): PaymentScanRow {
  return { description: "", authorUserId: "u-1", authorName: "Šéf", createdAt: "2026-09-01T09:00:00Z", updatedAt: "2026-09-01T09:00:00Z", ...overrides };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("prázdny stav ukáže výzvu k poznámke aj k nahratiu skenu", async () => {
  fetchPaymentNotes.mockResolvedValue([]);
  fetchPaymentScans.mockResolvedValue([]);
  render(<UhradySection onSessionExpired={() => {}} />);
  expect(await screen.findByTestId("uhrady-notes-empty")).toBeDefined();
  expect(await screen.findByTestId("uhrady-scans-empty")).toBeDefined();
});

it("zobrazí poznámky (autor) a skeny (thumbnail + popis) v poradí zo servera", async () => {
  fetchPaymentNotes.mockResolvedValue([noteRow({ id: "n-2", text: "zavolať do banky", authorName: "Štěpán" }), noteRow({ id: "n-1", text: "Fomei FA" })]);
  fetchPaymentScans.mockResolvedValue([scanRow({ id: "s-1", description: "Metalov 128 €" })]);
  render(<UhradySection onSessionExpired={() => {}} />);

  expect((await screen.findByTestId("uhrady-note-n-2")).textContent).toContain("zavolať do banky");
  expect(screen.getByTestId("uhrady-note-n-2").textContent).toContain("Štěpán");
  const desc = await screen.findByTestId<HTMLInputElement>("uhrady-desc-s-1");
  expect(desc.value).toBe("Metalov 128 €");
  expect(screen.getByTestId("uhrady-thumb-s-1")).toBeDefined();
});

it("pridá poznámku cez tlačidlo Pridať s orezaným textom a znovu načíta zoznam", async () => {
  fetchPaymentNotes.mockResolvedValue([]);
  fetchPaymentScans.mockResolvedValue([]);
  createPaymentNote.mockResolvedValue(undefined);
  render(<UhradySection onSessionExpired={() => {}} />);
  await screen.findByTestId("uhrady-notes-empty");

  fireEvent.change(screen.getByTestId("uhrady-note-input"), { target: { value: "  uhradiť DrevoNovak  " } });
  fireEvent.click(screen.getByTestId("uhrady-note-add"));
  await waitFor(() => {
    expect(createPaymentNote).toHaveBeenCalledWith("uhradiť DrevoNovak");
  });
  expect(fetchPaymentNotes).toHaveBeenCalledTimes(2); // úvodný load + po pridaní
});

it("zmaže poznámku cez kôš", async () => {
  fetchPaymentNotes.mockResolvedValue([noteRow({ id: "n-1", text: "Fomei FA" })]);
  fetchPaymentScans.mockResolvedValue([]);
  deletePaymentNote.mockResolvedValue(undefined);
  render(<UhradySection onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("uhrady-note-delete-n-1"));
  await waitFor(() => {
    expect(deletePaymentNote).toHaveBeenCalledWith("n-1");
  });
});

it("klik na thumbnail otvorí lightbox, zavrie sa tlačidlom ✕ aj klávesom Esc", async () => {
  fetchPaymentNotes.mockResolvedValue([]);
  fetchPaymentScans.mockResolvedValue([scanRow({ id: "s-1", description: "FA" })]);
  render(<UhradySection onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("uhrady-thumb-s-1"));
  expect(screen.getByTestId("uhrady-lightbox")).toBeDefined();

  // Zavrieť tlačidlom ✕.
  fireEvent.click(screen.getByTestId("uhrady-lightbox-close"));
  expect(screen.queryByTestId("uhrady-lightbox")).toBeNull();

  // Znova otvoriť a zavrieť klávesom Esc.
  fireEvent.click(screen.getByTestId("uhrady-thumb-s-1"));
  expect(screen.getByTestId("uhrady-lightbox")).toBeDefined();
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByTestId("uhrady-lightbox")).toBeNull();
  });
});

it("zmazanie skenu vyžaduje POTVRDENIE — až klik na Áno zavolá deletePaymentScan a odstráni dlaždicu", async () => {
  fetchPaymentNotes.mockResolvedValue([]);
  fetchPaymentScans.mockResolvedValue([scanRow({ id: "s-1", description: "FA" })]);
  deletePaymentScan.mockResolvedValue(undefined);
  render(<UhradySection onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("uhrady-delete-s-1"));
  // Zatiaľ NEZMAZANÉ — najprv sa pýta na potvrdenie.
  expect(deletePaymentScan).not.toHaveBeenCalled();
  expect(screen.getByTestId("uhrady-confirm-s-1")).toBeDefined();

  fireEvent.click(screen.getByTestId("uhrady-confirm-yes-s-1"));
  await waitFor(() => {
    expect(deletePaymentScan).toHaveBeenCalledWith("s-1");
  });
  await waitFor(() => {
    expect(screen.queryByTestId("uhrady-scan-s-1")).toBeNull();
  });
});

it("Zrušiť v potvrdení mazanie NEVYKONÁ", async () => {
  fetchPaymentNotes.mockResolvedValue([]);
  fetchPaymentScans.mockResolvedValue([scanRow({ id: "s-1" })]);
  render(<UhradySection onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("uhrady-delete-s-1"));
  fireEvent.click(screen.getByTestId("uhrady-confirm-no-s-1"));
  expect(deletePaymentScan).not.toHaveBeenCalled();
  expect(screen.getByTestId("uhrady-delete-s-1")).toBeDefined();
});

it("uloženie popisu na blur zavolá updatePaymentScanDescription s orezanou hodnotou", async () => {
  fetchPaymentNotes.mockResolvedValue([]);
  fetchPaymentScans.mockResolvedValue([scanRow({ id: "s-1", description: "" })]);
  updatePaymentScanDescription.mockResolvedValue(true);
  render(<UhradySection onSessionExpired={() => {}} />);

  const desc = await screen.findByTestId<HTMLInputElement>("uhrady-desc-s-1");
  fireEvent.change(desc, { target: { value: "  Fomei 250 €  " } });
  fireEvent.blur(desc);
  await waitFor(() => {
    expect(updatePaymentScanDescription).toHaveBeenCalledWith("s-1", "Fomei 250 €");
  });
});
