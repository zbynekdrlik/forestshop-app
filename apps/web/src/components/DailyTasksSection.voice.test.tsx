import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DailyTasksSection } from "./DailyTasksSection.js";
import type { RecordingResult } from "../useVoiceRecorder.js";

// issue 519: hlasová poznámka v pridávacom riadku. `useVoiceRecorder` je
// zamockovaný (jeho vlastný priebeh testuje `useVoiceRecorder.test.ts`) — tu
// overujeme, ako komponent VYKRESĽUJE stavy nahrávania a ako uploaduje výsledok.

const { fetchDailyTasks, createVoiceDailyTask } = vi.hoisted(() => ({
  fetchDailyTasks: vi.fn(),
  createVoiceDailyTask: vi.fn(),
}));
vi.mock("../dailyTasksApi.js", async (importActual) => {
  const actual = await importActual<typeof import("../dailyTasksApi.js")>();
  return { ...actual, fetchDailyTasks, createVoiceDailyTask };
});

// Ovládateľný mock hooku: `recorder` je mutovateľný, `capturedOnComplete` drží
// callback, ktorý komponent hooku odovzdal (na simuláciu dokončenej nahrávky).
const recorder = { state: "idle" as "idle" | "recording" | "processing", elapsedMs: 0, error: "", start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), reset: vi.fn() };
let capturedOnComplete: ((r: RecordingResult) => void) | null = null;
vi.mock("../useVoiceRecorder.js", async (importActual) => {
  const actual = await importActual<typeof import("../useVoiceRecorder.js")>();
  return {
    ...actual,
    useVoiceRecorder: (opts: { onComplete: (r: RecordingResult) => void }) => {
      capturedOnComplete = opts.onComplete;
      return recorder;
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  recorder.state = "idle";
  recorder.elapsedMs = 0;
  recorder.error = "";
  capturedOnComplete = null;
});

afterEach(() => {
  cleanup();
});

it("v pokoji ukáže mikrofón aj emoji tlačidlo; klik na mikrofón spustí nahrávanie", async () => {
  fetchDailyTasks.mockResolvedValueOnce([]);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("ulohy-empty");

  expect(screen.getByTestId("uloha-new-mic")).toBeTruthy();
  expect(screen.getByTestId("uloha-new-emoji")).toBeTruthy();
  expect(screen.getByTestId("uloha-new-input")).toBeTruthy();

  act(() => {
    screen.getByTestId("uloha-new-mic").click();
  });
  expect(recorder.start).toHaveBeenCalledTimes(1);
});

it("počas nahrávania ukáže lištu s časom, Stop a Zrušiť (namiesto vstupu)", async () => {
  fetchDailyTasks.mockResolvedValueOnce([]);
  recorder.state = "recording";
  recorder.elapsedMs = 3200;
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("ulohy-empty");

  expect(screen.getByTestId("uloha-rec-bar")).toBeTruthy();
  expect(screen.getByTestId("uloha-rec-time").textContent).toBe("0:03");
  expect(screen.queryByTestId("uloha-new-input")).toBeNull(); // vstup je skrytý počas nahrávania

  act(() => {
    screen.getByTestId("uloha-rec-stop").click();
  });
  expect(recorder.stop).toHaveBeenCalledTimes(1);
  act(() => {
    screen.getByTestId("uloha-rec-cancel").click();
  });
  expect(recorder.cancel).toHaveBeenCalledTimes(1);
});

it("počas prepisu ukáže stav prepisu (Prepisujem…)", async () => {
  fetchDailyTasks.mockResolvedValueOnce([]);
  recorder.state = "processing";
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("ulohy-empty");
  expect(screen.getByTestId("uloha-rec-processing").textContent).toContain("Prepisujem");
});

it("chybu z rekordéra (zamietnutý mikrofón) zobrazí ako upozornenie", async () => {
  fetchDailyTasks.mockResolvedValueOnce([]);
  recorder.error = "Prístup k mikrofónu bol zamietnutý.";
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("ulohy-empty");
  expect(screen.getByTestId("uloha-rec-error").textContent).toContain("mikrofón");
});

it("dokončená nahrávka sa uploadne, zoznam sa obnoví a rekordér sa resetuje", async () => {
  fetchDailyTasks.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  createVoiceDailyTask.mockResolvedValueOnce(undefined);
  render(<DailyTasksSection onSessionExpired={vi.fn()} />);
  await screen.findByTestId("ulohy-empty");

  const blob = new Blob([new Uint8Array(2048)], { type: "audio/webm" });
  await act(async () => {
    capturedOnComplete?.({ blob, mime: "audio/webm", durationMs: 4200 });
    await Promise.resolve();
  });

  expect(createVoiceDailyTask).toHaveBeenCalledWith(blob, "audio/webm", 4200);
  await waitFor(() => {
    expect(recorder.reset).toHaveBeenCalledTimes(1);
  });
  expect(fetchDailyTasks).toHaveBeenCalledTimes(2); // mount + po uploade
});
