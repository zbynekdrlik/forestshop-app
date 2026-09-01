import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DailyTasksSection } from "./DailyTasksSection.js";

const { fetchDailyTasks, createDailyTask, updateDailyTaskText, updateDailyTaskEmoji, setDailyTaskDone, deleteDailyTask } = vi.hoisted(() => ({
  fetchDailyTasks: vi.fn(),
  createDailyTask: vi.fn(),
  updateDailyTaskText: vi.fn(),
  updateDailyTaskEmoji: vi.fn(),
  setDailyTaskDone: vi.fn(),
  deleteDailyTask: vi.fn(),
}));

// `DailyTasksUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod ako
// `UpozorneniaSection.test.tsx`/`NedostupneSection.test.tsx` — `instanceof`
// v komponente musí fungovať).
vi.mock("../dailyTasksApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dailyTasksApi.js")>();
  return { ...actual, fetchDailyTasks, createDailyTask, updateDailyTaskText, updateDailyTaskEmoji, setDailyTaskDone, deleteDailyTask };
});

const ROW_A = { id: "task-a", text: "poslať DPD", emoji: null, authorUserId: "user-1", authorName: "Šéf", doneAt: null, hasAudio: false, audioDurationMs: null, createdAt: "2026-08-11T08:00:00.000Z", updatedAt: "2026-08-11T08:00:00.000Z" };
const ROW_B = { id: "task-b", text: "Nemáme sáčky", emoji: "🛍️", authorUserId: "user-2", authorName: "Kolega", doneAt: null, hasAudio: false, audioDurationMs: null, createdAt: "2026-08-11T09:00:00.000Z", updatedAt: "2026-08-11T09:00:00.000Z" };
const ROW_DONE = { id: "task-done", text: "Vybavená úloha", emoji: null, authorUserId: "user-1", authorName: "Šéf", doneAt: "2026-08-11T10:00:00.000Z", hasAudio: false, audioDurationMs: null, createdAt: "2026-08-11T07:00:00.000Z", updatedAt: "2026-08-11T10:00:00.000Z" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("zobrazí zoznam úloh z fetchDailyTasks", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ROW_B, ROW_A]);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);

  await screen.findByTestId("uloha-row-task-a");
  expect(screen.getByTestId("uloha-text-task-a").textContent).toBe("poslať DPD");
  expect(screen.getByTestId("uloha-text-task-b").textContent).toBe("Nemáme sáčky");
});

// issue 487: zdieľaný zoznam — autor sa zobrazuje pri každom riadku (ako pri Poznámkach).
it("zobrazí autora pri každom riadku (zdieľaný zoznam)", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ROW_B, ROW_A]);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);

  await screen.findByTestId("uloha-row-task-a");
  expect(screen.getByTestId("uloha-author-task-a").textContent).toBe("Šéf");
  expect(screen.getByTestId("uloha-author-task-b").textContent).toBe("Kolega");
});

it("prázdny zoznam ukáže výzvu, nie chybu", async () => {
  fetchDailyTasks.mockResolvedValueOnce([]);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("ulohy-empty");
});

it("Enter v novom vstupe vytvorí úlohu a vyčistí pole, žiadny formulár/dialóg", async () => {
  fetchDailyTasks.mockResolvedValueOnce([]).mockResolvedValueOnce([ROW_A]);
  createDailyTask.mockResolvedValueOnce(undefined);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("ulohy-empty");

  const input = screen.getByTestId<HTMLInputElement>("uloha-new-input");
  fireEvent.change(input, { target: { value: "poslať DPD" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => {
    expect(createDailyTask).toHaveBeenCalledWith("poslať DPD");
  });
  await screen.findByTestId("uloha-row-task-a");
  expect(input.value).toBe("");
});

it("prázdny text sa neodošle (tlačidlo Pridať je disabled, Enter nič nespraví)", async () => {
  fetchDailyTasks.mockResolvedValueOnce([]);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("ulohy-empty");

  const input = screen.getByTestId<HTMLInputElement>("uloha-new-input");
  expect(screen.getByTestId<HTMLButtonElement>("uloha-new-add").disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(createDailyTask).not.toHaveBeenCalled();
});

it("upraví text úlohy cez inline ✏️ toggle", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ROW_A]).mockResolvedValueOnce([{ ...ROW_A, text: "poslať DPD zajtra" }]);
  updateDailyTaskText.mockResolvedValueOnce(true);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("uloha-row-task-a");

  fireEvent.click(screen.getByTestId("uloha-edit-task-a"));
  const editInput = screen.getByTestId<HTMLInputElement>("uloha-edit-input-task-a");
  fireEvent.change(editInput, { target: { value: "poslať DPD zajtra" } });
  fireEvent.click(screen.getByTestId("uloha-edit-save-task-a"));

  await waitFor(() => {
    expect(updateDailyTaskText).toHaveBeenCalledWith("task-a", "poslať DPD zajtra");
  });
  await waitFor(() => {
    expect(screen.getByTestId("uloha-text-task-a").textContent).toBe("poslať DPD zajtra");
  });
});

// issue 471: emoji do TEXTU novej úlohy cez zdieľaný EmojiPickerButton (insert
// na pozíciu kurzora — presne ako Poznámky/440).
it("nový vstup: emoji z pickera sa vloží do textu novej úlohy", async () => {
  fetchDailyTasks.mockResolvedValueOnce([]);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("ulohy-empty");

  const input = screen.getByTestId<HTMLInputElement>("uloha-new-input");
  fireEvent.change(input, { target: { value: "poslať" } });
  fireEvent.click(screen.getByTestId("uloha-new-emoji"));
  fireEvent.click(within(screen.getByTestId("uloha-new-emoji-popover")).getByRole("button", { name: "Vložiť 🚀" }));

  await waitFor(() => {
    expect(input.value).toContain("🚀");
  });
});

// issue 471: emoji do TEXTU aj v inline edit režime.
it("edit editor: emoji z pickera sa vloží do upravovaného textu", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ROW_A]);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("uloha-row-task-a");

  fireEvent.click(screen.getByTestId("uloha-edit-task-a"));
  const editInput = screen.getByTestId<HTMLInputElement>("uloha-edit-input-task-a");
  fireEvent.change(editInput, { target: { value: "poslať DPD" } });
  fireEvent.click(screen.getByTestId("uloha-edit-emoji-task-a"));
  fireEvent.click(within(screen.getByTestId("uloha-edit-emoji-task-a-popover")).getByRole("button", { name: "Vložiť 🚚" }));

  await waitFor(() => {
    expect(editInput.value).toContain("🚚");
  });
});

// issue 471: označenie CELÉHO riadku emojkou — klik na 😊 otvorí picker,
// JEDNÝM klikom na emoji sa emoji rovno uloží (žiadne textové pole + Uložiť).
it("riadok: jedným klikom na emoji v pickeri sa emoji uloží (updateDailyTaskEmoji)", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ROW_A]).mockResolvedValueOnce([{ ...ROW_A, emoji: "🚀" }]);
  updateDailyTaskEmoji.mockResolvedValueOnce(true);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("uloha-row-task-a");

  fireEvent.click(screen.getByTestId("uloha-emoji-task-a"));
  fireEvent.click(within(screen.getByTestId("uloha-emoji-task-a-popover")).getByRole("button", { name: "Vložiť 🚀" }));

  await waitFor(() => {
    expect(updateDailyTaskEmoji).toHaveBeenCalledWith("task-a", "🚀");
  });
  await waitFor(() => {
    expect(screen.getByTestId("uloha-emoji-cell-task-a").textContent).toBe("🚀");
  });
});

// issue 471: voľba „bez emoji" v pickeri odstráni emoji riadku (null).
it("riadok: voľba bez emoji odstráni emoji úlohy (updateDailyTaskEmoji null)", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ROW_B]).mockResolvedValueOnce([{ ...ROW_B, emoji: null }]);
  updateDailyTaskEmoji.mockResolvedValueOnce(true);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("uloha-row-task-b");

  fireEvent.click(screen.getByTestId("uloha-emoji-task-b"));
  fireEvent.click(screen.getByTestId("uloha-emoji-task-b-clear"));

  await waitFor(() => {
    expect(updateDailyTaskEmoji).toHaveBeenCalledWith("task-b", null);
  });
});

it("označí úlohu ako vybavenú — riadok dostane triedu 'done'", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ROW_A]).mockResolvedValueOnce([{ ...ROW_A, doneAt: "2026-08-11T12:00:00.000Z" }]);
  setDailyTaskDone.mockResolvedValueOnce(true);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("uloha-row-task-a");

  fireEvent.click(screen.getByTestId("uloha-done-task-a"));

  await waitFor(() => {
    expect(setDailyTaskDone).toHaveBeenCalledWith("task-a", true);
  });
  await waitFor(() => {
    expect(screen.getByTestId("uloha-row-task-a").className).toContain("done");
  });
});

// Issue 403: prepínač je teraz skutočný `<input type="checkbox">` (predtým
// `<button>` s Unicode ☐/☑) — regresný test na skutočnú rolu/`checked`
// atribút, nielen na testid (ten by prešiel pre hocijaký element).
it("prepínač 'vybavené' je skutočný checkbox s rolou a atribútom checked, nie textové tlačidlo", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ROW_A]);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("uloha-row-task-a");

  const checkbox = screen.getByRole<HTMLInputElement>("checkbox", { name: "Označiť ako vybavené" });
  expect(checkbox.type).toBe("checkbox");
  expect(checkbox.checked).toBe(false);
});

it("vybavená úloha OSTÁVA v zozname (nezmizne), len je stlmená", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ROW_DONE]);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("uloha-row-task-done");
  expect(screen.getByTestId("uloha-row-task-done").className).toContain("done");
});

it("odstráni úlohu okamžite, bez potvrdzovacieho dialógu", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ROW_A]).mockResolvedValueOnce([]);
  deleteDailyTask.mockResolvedValueOnce(undefined);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("uloha-row-task-a");

  fireEvent.click(screen.getByTestId("uloha-delete-task-a"));

  await waitFor(() => {
    expect(deleteDailyTask).toHaveBeenCalledWith("task-a");
  });
  await screen.findByTestId("ulohy-empty");
});

it("pri 401 (session vypršala) zavolá onSessionExpired", async () => {
  const { DailyTasksUnauthorizedError } = await import("../dailyTasksApi.js");
  fetchDailyTasks.mockRejectedValueOnce(new DailyTasksUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<DailyTasksSection onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalled();
  });
});

// Code review: rovnaký nález ako issue 251's `SupplierLinksSection.tsx`/
// `PairingSection.tsx` — bez "latest ref" guardu by uloženie riadku A (ešte
// čakajúce na odpoveď) zavrelo editor riadku B, otvorený medzitým.
it("uloženie textu riadku A (ešte čakajúce na odpoveď) nesmie zavrieť editor riadku B otvorený medzitým", async () => {
  fetchDailyTasks.mockResolvedValue([ROW_B, ROW_A]);
  let resolveA: (v: boolean) => void = () => {};
  updateDailyTaskText.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        resolveA = resolve;
      }),
  );
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("uloha-row-task-a");

  // Otvoriť editor riadku A a uložiť — odpoveď zatiaľ NEDORAZILA.
  fireEvent.click(screen.getByTestId("uloha-edit-task-a"));
  fireEvent.click(screen.getByTestId("uloha-edit-save-task-a"));
  await waitFor(() => {
    expect(updateDailyTaskText).toHaveBeenCalledWith("task-a", "poslať DPD");
  });

  // Kým A čaká, otvoriť editor riadku B (appka dovolí len JEDEN naraz).
  fireEvent.click(screen.getByTestId("uloha-edit-task-b"));
  expect(screen.getByTestId("uloha-edit-input-task-b")).toBeTruthy();

  // Teraz nech odpoveď A dorazí — editor riadku B musí OSTAŤ otvorený.
  resolveA(true);
  await waitFor(() => {
    expect(fetchDailyTasks).toHaveBeenCalledTimes(2); // mount + po uložení A
  });
  expect(screen.getByTestId("uloha-edit-input-task-b")).toBeTruthy();
});

it("pri 401 POČAS mutácie (nielen počiatočného načítania) tiež zavolá onSessionExpired", async () => {
  const { DailyTasksUnauthorizedError } = await import("../dailyTasksApi.js");
  fetchDailyTasks.mockResolvedValueOnce([ROW_A]);
  setDailyTaskDone.mockRejectedValueOnce(new DailyTasksUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<DailyTasksSection onSessionExpired={onSessionExpired} />);
  await screen.findByTestId("uloha-row-task-a");

  fireEvent.click(screen.getByTestId("uloha-done-task-a"));

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalled();
  });
});

// issue 471: v edit režime sa riadkové akcie (vrátane riadkového PICK pickera)
// schovajú a namiesto nich je pri textovom poli INSERT picker na vloženie emoji
// DO textu — nie sú to teda dva pickery naraz, ale prepnutie z označenia riadku
// na vkladanie do textu.
it("edit režim ukáže text-insert picker a schová riadkový pick picker", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ROW_A]);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("uloha-row-task-a");

  // Pred úpravou: riadkový pick picker je prítomný, text-insert picker nie.
  expect(screen.getByTestId("uloha-emoji-task-a")).toBeTruthy();
  expect(screen.queryByTestId("uloha-edit-emoji-task-a")).toBeNull();

  fireEvent.click(screen.getByTestId("uloha-edit-task-a"));

  // V edit režime: text-insert picker je, riadkový pick picker sa schoval.
  expect(screen.getByTestId("uloha-edit-emoji-task-a")).toBeTruthy();
  expect(screen.queryByTestId("uloha-emoji-task-a")).toBeNull();
});
