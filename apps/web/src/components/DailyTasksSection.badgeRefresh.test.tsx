import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DailyTasksBadgeRefreshContext } from "../dailyTasksBadgeContext.js";
import { DailyTasksSection } from "./DailyTasksSection.js";

// issue 473: odznak počtu v ľavom menu klamal, kým sa stránka neobnovila —
// mutácia (pridať/odfajknúť/zmazať) na PRÁVE otvorenej obrazovke nemala žiadny
// spúšťač refetchu. Tento test overuje, že `DailyTasksSection` po KAŽDEJ
// count-meniacej mutácii zavolá `refresh()` z `DailyTasksBadgeRefreshContext`
// (v `App.tsx` je nahradený spy funkciou) — rovnaký vzor ako
// `UpozorneniaSection.badgeRefresh.test.tsx`. Úprava textu count NEMENÍ, takže
// refresh NEvolá.

const { fetchDailyTasks, createDailyTask, setDailyTaskDone, deleteDailyTask, updateDailyTaskText } = vi.hoisted(() => ({
  fetchDailyTasks: vi.fn(),
  createDailyTask: vi.fn(),
  setDailyTaskDone: vi.fn(),
  deleteDailyTask: vi.fn(),
  updateDailyTaskText: vi.fn(),
}));

vi.mock("../dailyTasksApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dailyTasksApi.js")>();
  return { ...actual, fetchDailyTasks, createDailyTask, setDailyTaskDone, deleteDailyTask, updateDailyTaskText };
});

const ULOHA = {
  id: "task-1",
  text: "poslať DPD",
  emoji: null,
  doneAt: null,
  createdAt: "2026-08-23T08:00:00.000Z",
  updatedAt: "2026-08-23T08:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderWithRefresh(refresh: () => void) {
  render(
    <DailyTasksBadgeRefreshContext.Provider value={{ refresh }}>
      <DailyTasksSection onSessionExpired={vi.fn()} />
    </DailyTasksBadgeRefreshContext.Provider>,
  );
}

it("pridanie úlohy zavolá refresh() (odznak sa refetchne bez zmeny záložky)", async () => {
  fetchDailyTasks.mockResolvedValueOnce([]).mockResolvedValueOnce([ULOHA]);
  createDailyTask.mockResolvedValue(undefined);
  const refresh = vi.fn();
  renderWithRefresh(refresh);
  await screen.findByTestId("ulohy-empty");
  expect(refresh).not.toHaveBeenCalled();

  fireEvent.change(screen.getByTestId("uloha-new-input"), { target: { value: "poslať DPD" } });
  fireEvent.click(screen.getByTestId("uloha-new-add"));

  await waitFor(() => {
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

it("odfajknutie úlohy (done toggle) zavolá refresh()", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ULOHA]).mockResolvedValueOnce([{ ...ULOHA, doneAt: "2026-08-23T09:00:00.000Z" }]);
  setDailyTaskDone.mockResolvedValue(true);
  const refresh = vi.fn();
  renderWithRefresh(refresh);
  await screen.findByTestId("uloha-row-task-1");
  expect(refresh).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("uloha-done-task-1"));

  await waitFor(() => {
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

it("zmazanie úlohy zavolá refresh()", async () => {
  fetchDailyTasks.mockResolvedValueOnce([ULOHA]).mockResolvedValueOnce([]);
  deleteDailyTask.mockResolvedValue(undefined);
  const refresh = vi.fn();
  renderWithRefresh(refresh);
  await screen.findByTestId("uloha-row-task-1");

  fireEvent.click(screen.getByTestId("uloha-delete-task-1"));

  await waitFor(() => {
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

it("úprava TEXTU úlohy NEZAVOLÁ refresh() (count sa nemení)", async () => {
  fetchDailyTasks.mockResolvedValue([ULOHA]);
  updateDailyTaskText.mockResolvedValue(true);
  const refresh = vi.fn();
  renderWithRefresh(refresh);
  await screen.findByTestId("uloha-row-task-1");

  fireEvent.click(screen.getByTestId("uloha-edit-task-1"));
  fireEvent.change(screen.getByTestId("uloha-edit-input-task-1"), { target: { value: "poslať DPD zajtra" } });
  fireEvent.click(screen.getByTestId("uloha-edit-save-task-1"));

  await waitFor(() => {
    expect(updateDailyTaskText).toHaveBeenCalledTimes(1);
  });
  expect(refresh).not.toHaveBeenCalled();
});
