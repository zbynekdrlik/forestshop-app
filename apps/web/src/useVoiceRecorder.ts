import { useCallback, useEffect, useRef, useState } from "react";

// issue 519: nahrávanie hlasovej poznámky v prehliadači (vzor Messenger).
// `getUserMedia` + `MediaRecorder`. Hook drží stav (idle/recording/processing),
// časovač a čisté ukončenie/zrušenie; komponent rieši upload a zoznam.

export type RecorderState = "idle" | "recording" | "processing";

export interface RecordingResult {
  readonly blob: Blob;
  readonly mime: string;
  readonly durationMs: number;
}

/** Formát času nahrávania „m:ss" — čistá funkcia, samostatne testovateľná. */
export function formatRecordingTime(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${seconds.toString().padStart(2, "0")}`;
}

/** Preferovaný `mimeType` pre `MediaRecorder` — Chrome/Android webm/opus,
 * Safari/iOS spadne na `mp4`. Ak nič nesedí, `undefined` = default prehliadača. */
export function pickRecorderMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  const supported = typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function";
  if (!supported) return undefined;
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

interface UseVoiceRecorder {
  readonly state: RecorderState;
  readonly elapsedMs: number;
  readonly error: string;
  readonly start: () => void;
  readonly stop: () => void;
  readonly cancel: () => void;
  // Vráti hook do `idle` po tom, ako komponent dokončil upload (úspech aj
  // zlyhanie) z `processing` stavu.
  readonly reset: () => void;
}

export function useVoiceRecorder(options: {
  readonly onComplete: (result: RecordingResult) => void;
  readonly onError?: (message: string) => void;
}): UseVoiceRecorder {
  const { onComplete, onError } = options;
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // `true` = používateľ zrušil, výslednú nahrávku zahoď (`onstop` sa aj tak spustí).
  const cancelledRef = useRef(false);
  // SYNCHRÓNNa poistka proti dvojkliku počas čakania na `getUserMedia`: `state`
  // sa stane "recording" AŽ v `.then`, takže rýchly druhý klik v tom istom ticku
  // by prešiel `state !== "idle"` guardom a otvoril DRUHÝ mikrofónový stream
  // (prvý by ostal navždy zapnutý — viditeľný únik). Ref sa mení synchrónne.
  const startingRef = useRef(false);

  // "Latest ref" na `onComplete`, aby ho `onstop` handler videl aktuálny bez
  // toho, aby sa musel re-registrovať (recorder žije naprieč rendermi).
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    if (streamRef.current !== null) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  const reportError = useCallback(
    (message: string) => {
      setError(message);
      onError?.(message);
    },
    [onError],
  );

  const start = useCallback(() => {
    if (state !== "idle" || startingRef.current) return;
    setError("");
    cancelledRef.current = false;
    chunksRef.current = [];
    // getUserMedia môže byť odmietnutý (zamietnutý mikrofón) alebo chýbať
    // (nezabezpečený kontext) — obe končia inline hláškou, nie console chybou.
    const media = navigator.mediaDevices as MediaDevices | undefined;
    if (media === undefined || typeof media.getUserMedia !== "function") {
      reportError("Mikrofón nie je dostupný v tomto prehliadači.");
      return;
    }
    startingRef.current = true;
    media
      .getUserMedia({ audio: true })
      .then((stream) => {
        startingRef.current = false;
        streamRef.current = stream;
        const mimeType = pickRecorderMimeType();
        const recorder = mimeType === undefined ? new MediaRecorder(stream) : new MediaRecorder(stream, { mimeType });
        recorderRef.current = recorder;
        recorder.ondataavailable = (e: BlobEvent) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          stopTimer();
          releaseStream();
          const durationMs = Date.now() - startedAtRef.current;
          const wasCancelled = cancelledRef.current;
          const chunks = chunksRef.current;
          chunksRef.current = [];
          recorderRef.current = null;
          if (wasCancelled || chunks.length === 0) {
            setState("idle");
            setElapsedMs(0);
            return;
          }
          const mime = recorder.mimeType !== "" ? recorder.mimeType : (mimeType ?? "audio/webm");
          const blob = new Blob(chunks, { type: mime });
          setState("processing");
          onCompleteRef.current({ blob, mime, durationMs });
        };
        startedAtRef.current = Date.now();
        setElapsedMs(0);
        setState("recording");
        recorder.start();
        timerRef.current = setInterval(() => {
          setElapsedMs(Date.now() - startedAtRef.current);
        }, 200);
      })
      .catch(() => {
        startingRef.current = false;
        releaseStream();
        reportError("Prístup k mikrofónu bol zamietnutý.");
      });
  }, [state, reportError, stopTimer, releaseStream]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state !== "inactive") recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      stopTimer();
      releaseStream();
      setState("idle");
      setElapsedMs(0);
    }
  }, [stopTimer, releaseStream]);

  // Po dokončení uploadu vráti komponent hook do `idle` (nižšie), ale keby sa
  // odmountoval počas nahrávania, uvoľni mikrofón aj časovač. `cancelledRef`
  // sa nastaví na `true`, aby prípadné `onstop` po odmountovaní (napr.
  // prepnutie záložky uprostred diktovania) nevytvorilo úlohu z čiastočnej
  // nahrávky, ktorú používateľ vedome neuložil (ani Hotovo, ani Zrušiť).
  useEffect(
    () => () => {
      cancelledRef.current = true;
      stopTimer();
      releaseStream();
    },
    [stopTimer, releaseStream],
  );

  // Komponent po uploadovaní (úspech aj zlyhanie) vráti hook do `idle`.
  const reset = useCallback(() => {
    setState("idle");
    setElapsedMs(0);
    setError("");
  }, []);

  return { state, elapsedMs, error, start, stop, cancel, reset };
}
