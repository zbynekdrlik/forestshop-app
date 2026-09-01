import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRecordingTime, pickRecorderMimeType, useVoiceRecorder, type RecordingResult } from "./useVoiceRecorder.js";

describe("formatRecordingTime", () => {
  it("formátuje ms na m:ss", () => {
    expect(formatRecordingTime(0)).toBe("0:00");
    expect(formatRecordingTime(3200)).toBe("0:03");
    expect(formatRecordingTime(65_000)).toBe("1:05");
    expect(formatRecordingTime(-500)).toBe("0:00");
  });
});

describe("pickRecorderMimeType", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("vráti prvý podporovaný typ", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: (t: string) => t === "audio/webm" });
    expect(pickRecorderMimeType()).toBe("audio/webm");
  });
  it("vráti undefined, keď MediaRecorder chýba", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    expect(pickRecorderMimeType()).toBeUndefined();
  });
});

// Falošný MediaRecorder — pri stop() vyprodukuje blob a spustí onstop.
class FakeMediaRecorder {
  static isTypeSupported = (t: string): boolean => t === "audio/webm;codecs=opus";
  public ondataavailable: ((e: { data: Blob }) => void) | null = null;
  public onstop: (() => void) | null = null;
  public state: "inactive" | "recording" = "inactive";
  public mimeType: string;
  constructor(
    public stream: MediaStream,
    opts?: { mimeType?: string },
  ) {
    this.mimeType = opts?.mimeType ?? "";
  }
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

describe("useVoiceRecorder — priebeh nahrávania", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubMedia(getUserMedia: () => Promise<MediaStream>): ReturnType<typeof vi.fn> {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const gum = vi.fn(getUserMedia);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: gum },
    });
    return gum;
  }
  const fakeStream = (): MediaStream => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream;

  it("start → recording, stop → onComplete s blobom, reset → idle", async () => {
    stubMedia(() => Promise.resolve(fakeStream()));
    const completed: RecordingResult[] = [];
    const { result } = renderHook(() => useVoiceRecorder({ onComplete: (r) => completed.push(r) }));

    expect(result.current.state).toBe("idle");
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.state).toBe("recording");
    });

    act(() => {
      result.current.stop();
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]?.blob.size).toBe(2048);
    expect(completed[0]?.mime).toBe("audio/webm;codecs=opus");
    expect(result.current.state).toBe("processing");

    act(() => {
      result.current.reset();
    });
    expect(result.current.state).toBe("idle");
  });

  it("dvojklik počas čakania na getUserMedia otvorí LEN JEDEN mikrofónový stream", async () => {
    const gum = stubMedia(() => Promise.resolve(fakeStream()));
    const { result } = renderHook(() => useVoiceRecorder({ onComplete: vi.fn() }));
    act(() => {
      // Dva rýchle kliky v tom istom ticku — `state` je ešte "idle", bráni len
      // synchrónny `startingRef`.
      result.current.start();
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.state).toBe("recording");
    });
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it("zrušenie počas nahrávania NEZAVOLÁ onComplete a vráti idle", async () => {
    stubMedia(() => Promise.resolve(fakeStream()));
    const completed: RecordingResult[] = [];
    const { result } = renderHook(() => useVoiceRecorder({ onComplete: (r) => completed.push(r) }));
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.state).toBe("recording");
    });
    act(() => {
      result.current.cancel();
    });
    expect(completed).toHaveLength(0);
    expect(result.current.state).toBe("idle");
  });

  it("zamietnutý mikrofón → chybová hláška, žiadny onComplete", async () => {
    stubMedia(() => Promise.reject(new Error("NotAllowedError")));
    const completed: RecordingResult[] = [];
    const { result } = renderHook(() => useVoiceRecorder({ onComplete: (r) => completed.push(r) }));
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.error).not.toBe("");
    });
    expect(result.current.state).toBe("idle");
    expect(completed).toHaveLength(0);
  });
});
