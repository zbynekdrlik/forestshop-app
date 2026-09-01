import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DailyTaskRow, type DailyTaskRowProps } from "./DailyTaskRow.js";
import type { DailyTaskRow as DailyTaskRowData } from "../dailyTasksApi.js";

// issue 519: ovládanie nahrávky pri riadku úlohy (prehrať / dĺžka / zmazať).

const BASE_ROW: DailyTaskRowData = {
  id: "task-1",
  text: "Poznámka z auta",
  emoji: null,
  authorUserId: "u1",
  authorName: "Šéf",
  doneAt: null,
  hasAudio: true,
  audioDurationMs: 7000,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
};

function renderRow(row: DailyTaskRowData, overrides: Partial<DailyTaskRowProps> = {}): { onDeleteAudio: ReturnType<typeof vi.fn> } {
  const onDeleteAudio = vi.fn();
  const props: DailyTaskRowProps = {
    row,
    busy: false,
    editing: false,
    draftValue: row.text,
    editInputRef: { current: null },
    onToggleDone: vi.fn(),
    onOpenTextEditor: vi.fn(),
    onDraftChange: vi.fn(),
    onSaveText: vi.fn(),
    onCancelEdit: vi.fn(),
    onSaveRowEmoji: vi.fn(),
    onRemove: vi.fn(),
    onDeleteAudio,
    ...overrides,
  };
  render(<DailyTaskRow {...props} />);
  return { onDeleteAudio };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("riadok BEZ nahrávky nemá audio ovládanie", () => {
  renderRow({ ...BASE_ROW, hasAudio: false, audioDurationMs: null });
  expect(screen.queryByTestId("uloha-audio-task-1")).toBeNull();
});

it("riadok S nahrávkou ukáže prehrať (s dĺžkou) a zmazať nahrávku", () => {
  renderRow(BASE_ROW);
  expect(screen.getByTestId("uloha-audio-task-1")).toBeTruthy();
  expect(screen.getByTestId("uloha-audio-play-task-1").textContent).toContain("0:07");
  expect(screen.getByTestId("uloha-audio-delete-task-1")).toBeTruthy();
});

it("klik na zmazať nahrávku zavolá onDeleteAudio s id úlohy", () => {
  const { onDeleteAudio } = renderRow(BASE_ROW);
  act(() => {
    screen.getByTestId("uloha-audio-delete-task-1").click();
  });
  expect(onDeleteAudio).toHaveBeenCalledWith("task-1");
});

it("klik na prehrať spustí prehrávanie nahrávky", () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  renderRow(BASE_ROW);
  act(() => {
    screen.getByTestId("uloha-audio-play-task-1").click();
  });
  expect(play).toHaveBeenCalledTimes(1);
});

it("zlyhanie prehrávania (cross-device kodek) ukáže viditeľnú hlášku, nie tiché zlyhanie", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("NotSupportedError"));
  renderRow(BASE_ROW);
  await act(async () => {
    screen.getByTestId("uloha-audio-play-task-1").click();
    await Promise.resolve();
  });
  expect(screen.getByTestId("uloha-audio-failed-task-1").textContent).toContain("Prehrávanie zlyhalo");
});
