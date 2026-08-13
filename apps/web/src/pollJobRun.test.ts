import { expect, it, vi } from "vitest";
import { pollUntilJobDone } from "./pollJobRun.js";

// issue 413: run-now beží ASYNC — táto funkcia je to, čo obrazovky použijú
// na PREBRATIE výsledku namiesto priamej POST odpovede. `maxIntervalMs`
// tu drží testy rýchle (malý strop na exponenciálny rast), žiadny
// `vi.useFakeTimers()` netreba — rovnaký vzor ako iné čisto asynchrónne
// testy v tomto repe.

it("vráti stav hneď, keď prvý beh nie je running", async () => {
  const fetchStatus = vi.fn().mockResolvedValue({ lastRun: { status: "success" as const } });
  const result = await pollUntilJobDone(fetchStatus, { maxIntervalMs: 5 });
  expect(result).toEqual({ lastRun: { status: "success" as const } });
  expect(fetchStatus).toHaveBeenCalledTimes(1);
});

it("vráti stav hneď, keď lastRun je null", async () => {
  const fetchStatus = vi.fn().mockResolvedValue({ lastRun: null });
  const result = await pollUntilJobDone(fetchStatus, { maxIntervalMs: 5 });
  expect(result).toEqual({ lastRun: null });
  expect(fetchStatus).toHaveBeenCalledTimes(1);
});

it("opakuje volanie, kým beh ešte running, a vráti finálny stav", async () => {
  const fetchStatus = vi
    .fn()
    .mockResolvedValueOnce({ lastRun: { status: "running" as const } })
    .mockResolvedValueOnce({ lastRun: { status: "running" as const } })
    .mockResolvedValueOnce({ lastRun: { status: "failure" as const } });

  const result = await pollUntilJobDone(fetchStatus, { maxIntervalMs: 5 });
  expect(result).toEqual({ lastRun: { status: "failure" as const } });
  expect(fetchStatus).toHaveBeenCalledTimes(3);
});

it("vzdá sa po maxAttempts a vráti posledný (stále running) stav — nikdy nečaká navždy", async () => {
  const fetchStatus = vi.fn().mockResolvedValue({ lastRun: { status: "running" as const } });
  const result = await pollUntilJobDone(fetchStatus, { maxIntervalMs: 2, maxAttempts: 3 });
  expect(result).toEqual({ lastRun: { status: "running" as const } });
  // 1 prvotné volanie + 3 opakovania = 4.
  expect(fetchStatus).toHaveBeenCalledTimes(4);
});

it("interval medzi pokusmi RASTIE (exponenciálne, orezaný stropom maxIntervalMs)", async () => {
  vi.useFakeTimers();
  try {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({ lastRun: { status: "running" as const } })
      .mockResolvedValueOnce({ lastRun: { status: "running" as const } })
      .mockResolvedValueOnce({ lastRun: { status: "running" as const } })
      .mockResolvedValueOnce({ lastRun: { status: "success" as const } });

    const promise = pollUntilJobDone(fetchStatus, { maxIntervalMs: 1000 });
    // 500, min(1000,1000), min(2000,1000) — presne tri čakania medzi
    // štyrmi volaniami `fetchStatus`.
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchStatus).toHaveBeenCalledTimes(4);

    const result = await promise;
    expect(result).toEqual({ lastRun: { status: "success" as const } });
  } finally {
    vi.useRealTimers();
  }
});
