import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const ROW_A = { id: "task-a", text: "poslať DPD", emoji: null, doneAt: null, createdAt: "2026-08-11T08:00:00.000Z", updatedAt: "2026-08-11T08:00:00.000Z" };
const ROW_B = { id: "task-b", text: "Nemáme sáčky", emoji: "🛍️", doneAt: null, createdAt: "2026-08-11T09:00:00.000Z", updatedAt: "2026-08-11T09:00:00.000Z" };
const ROW_DONE = { id: "task-done", text: "Vybavená úloha", emoji: null, doneAt: "2026-08-11T10:00:00.000Z", createdAt: "2026-08-11T07:00:00.000Z", updatedAt: "2026-08-11T10:00:00.000Z" };

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

it("pridá emoji cez inline 😊 toggle", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ROW_A]).mockResolvedValueOnce([{ ...ROW_A, emoji: "🚚" }]);
  updateDailyTaskEmoji.mockResolvedValueOnce(true);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("uloha-row-task-a");

  fireEvent.click(screen.getByTestId("uloha-emoji-task-a"));
  const emojiInput = screen.getByTestId<HTMLInputElement>("uloha-emoji-input-task-a");
  fireEvent.change(emojiInput, { target: { value: "🚚" } });
  fireEvent.click(screen.getByTestId("uloha-emoji-save-task-a"));

  await waitFor(() => {
    expect(updateDailyTaskEmoji).toHaveBeenCalledWith("task-a", "🚚");
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
