import { useCallback, useContext, useEffect, useRef, useState, type JSX } from "react";
import {
  createDailyTask,
  createVoiceDailyTask,
  DailyTasksUnauthorizedError,
  deleteDailyTask,
  deleteDailyTaskAudio,
  fetchDailyTasks,
  setDailyTaskDone,
  updateDailyTaskEmoji,
  updateDailyTaskText,
  type DailyTaskRow as DailyTaskRowData,
} from "../dailyTasksApi.js";
import { DailyTasksBadgeRefreshContext } from "../dailyTasksBadgeContext.js";
import { formatRecordingTime, useVoiceRecorder, type RecordingResult } from "../useVoiceRecorder.js";
import { DailyTaskRow } from "./DailyTaskRow.js";
import { EmojiPickerButton } from "./EmojiPickerButton.js";

// issue 342 + 487: "Dôležité → Úlohy na dnes" — zdieľaný zoznam úloh (každý účet
// vidí a smie odfajknúť/upraviť/zmazať všetky; autor sa zobrazuje pri riadku).
// issue 519: hlasová poznámka (Messenger-vzor) — mikrofón pri vstupe novej
// úlohy. Mobil: mikrofón NAHRÁDZA emoji (emoji je len desktop cez CSS
// `@media (max-width:36rem)`); desktop: mikrofón POPRI emoji. Stlač mikrofón →
// nahráva → Hotovo → prepis (Whisper) alebo audio-only pri zlyhaní; nahrávka sa
// dá potom prehrať aj zmazať (`DailyTaskRow`). Per-riadok rendering je vyčlenený
// do `DailyTaskRow.tsx` (eslint `max-lines: 400`).

export function DailyTasksSection({ onSessionExpired }: { readonly onSessionExpired: () => void }): JSX.Element {
  const [rows, setRows] = useState<readonly DailyTaskRowData[] | null>(null);
  const [error, setError] = useState("");
  const [newText, setNewText] = useState("");
  const [busyId, setBusyId] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<Record<string, string>>({});

  const { refresh: badgeRefresh } = useContext(DailyTasksBadgeRefreshContext);

  const newTextRef = useRef<HTMLInputElement>(null);
  const editTextRef = useRef<HTMLInputElement>(null);

  const editingTextIdRef = useRef(editingTextId);
  editingTextIdRef.current = editingTextId;

  const load = useCallback(() => {
    fetchDailyTasks()
      .then((data) => {
        setRows(data);
      })
      .catch((err: unknown) => {
        if (err instanceof DailyTasksUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Úlohy sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(() => {
    load();
  }, [load]);

  const handleActionError = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof DailyTasksUnauthorizedError) {
        onSessionExpired();
        return;
      }
      setError(fallback);
    },
    [onSessionExpired],
  );

  const addTask = useCallback(() => {
    const text = newText.trim();
    if (text === "" || creating) return;
    setCreating(true);
    setError("");
    createDailyTask(text)
      .then(() => {
        setNewText("");
        load();
        badgeRefresh();
      })
      .catch((err: unknown) => {
        handleActionError(err, "Úlohu sa nepodarilo pridať — skúste to znova.");
      })
      .finally(() => {
        setCreating(false);
      });
  }, [newText, creating, load, handleActionError, badgeRefresh]);

  // issue 519: hlasová poznámka. `useVoiceRecorder` nahrá blob; po „Hotovo" ho
  // uploadneme a zoznam obnovíme. Reset hooku (`processing` → `idle`) beží cez
  // ref (recorder objekt sa mení každý render). Zlyhanie uploadu = bežná chyba,
  // nahrávka sa NA SERVERI aj tak neuloží (upload zlyhal), používateľ skúsi
  // znova — server-side nikdy nestratí ÚSPEŠNE nahranú nahrávku (audio-only
  // fallback pri zlyhaní PREPISU, nie uploadu).
  const recorderResetRef = useRef<() => void>(() => {
    // nastaví sa nižšie z `recorder.reset` (placeholder pre prvý render)
  });
  const uploadRecording = useCallback(
    (result: RecordingResult) => {
      setError("");
      createVoiceDailyTask(result.blob, result.mime, result.durationMs)
        .then(() => {
          load();
          badgeRefresh();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Hlasovú poznámku sa nepodarilo uložiť — skúste to znova.");
        })
        .finally(() => {
          recorderResetRef.current();
        });
    },
    [load, badgeRefresh, handleActionError],
  );
  const recorder = useVoiceRecorder({ onComplete: uploadRecording });
  recorderResetRef.current = recorder.reset;

  const toggleDone = useCallback(
    (row: DailyTaskRowData) => {
      setBusyId(row.id);
      setError("");
      setDailyTaskDone(row.id, row.doneAt === null)
        .then(() => {
          load();
          badgeRefresh();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Akcia zlyhala — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError, badgeRefresh],
  );

  const saveText = useCallback(
    (id: string) => {
      const text = (textDraft[id] ?? "").trim();
      if (text === "") return;
      setBusyId(id);
      setError("");
      updateDailyTaskText(id, text)
        .then(() => {
          if (editingTextIdRef.current === id) setEditingTextId(null);
          load();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Text sa nepodarilo uložiť — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [textDraft, load, handleActionError],
  );

  const saveRowEmoji = useCallback(
    (id: string, emoji: string | null) => {
      setBusyId(id);
      setError("");
      updateDailyTaskEmoji(id, emoji)
        .then(() => {
          load();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Emoji sa nepodarilo uložiť — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError],
  );

  const openTextEditor = useCallback((row: DailyTaskRowData) => {
    setTextDraft((d) => ({ ...d, [row.id]: row.text }));
    setEditingTextId(row.id);
  }, []);

  const removeTask = useCallback(
    (id: string) => {
      setBusyId(id);
      setError("");
      deleteDailyTask(id)
        .then(() => {
          load();
          badgeRefresh();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Úlohu sa nepodarilo odstrániť — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError, badgeRefresh],
  );

  // issue 519: zmazať LEN nahrávku (úloha aj text ostávajú).
  const removeAudio = useCallback(
    (id: string) => {
      setBusyId(id);
      setError("");
      deleteDailyTaskAudio(id)
        .then(() => {
          load();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Nahrávku sa nepodarilo odstrániť — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError],
  );

  const onDraftChange = useCallback((id: string, value: string) => {
    setTextDraft((d) => ({ ...d, [id]: value }));
  }, []);
  const cancelEdit = useCallback(() => {
    setEditingTextId(null);
  }, []);

  const intro = <p>Zdieľaný zoznam úloh — nahrádza poznámky písané do Discordu. Vidia ho všetky prihlásené účty; pri každej úlohe je jej autor.</p>;

  const recording = recorder.state !== "idle";
  const addRow = (
    <div className="ulohy-add-row" data-testid="uloha-add-row">
      {recording ? (
        <div className="ulohy-rec-bar" data-testid="uloha-rec-bar">
          {recorder.state === "recording" ? (
            <>
              <span className="ulohy-rec-dot" aria-hidden="true" />
              <span className="ulohy-rec-time" role="status" data-testid="uloha-rec-time">
                {formatRecordingTime(recorder.elapsedMs)}
              </span>
              <button type="button" className="btn sm" onClick={recorder.cancel} aria-label="Zrušiť nahrávanie" data-testid="uloha-rec-cancel">
                ✕ Zrušiť
              </button>
              <button type="button" className="btn good sm" onClick={recorder.stop} aria-label="Ukončiť nahrávanie" data-testid="uloha-rec-stop">
                ■ Hotovo
              </button>
            </>
          ) : (
            <span className="ulohy-rec-processing" role="status" data-testid="uloha-rec-processing">
              Prepisujem…
            </span>
          )}
        </div>
      ) : (
        <>
          <input
            ref={newTextRef}
            value={newText}
            onChange={(e) => {
              setNewText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTask();
              }
            }}
            aria-label="Nová úloha"
            placeholder="Napíš úlohu a stlač Enter…"
            data-testid="uloha-new-input"
            disabled={creating}
          />
          {/* issue 519: mikrofón — VŽDY viditeľný. Na mobile (CSS
              `@media max-width:36rem`) je emoji skrytý, takže mikrofón ho
              nahrádza; na desktope sú oba. */}
          <button
            type="button"
            className="uloha-mic-btn"
            onClick={recorder.start}
            disabled={creating}
            title="Nahrať hlasovú poznámku"
            aria-label="Nahrať hlasovú poznámku"
            data-testid="uloha-new-mic"
          >
            🎤
          </button>
          <EmojiPickerButton targetRef={newTextRef} value={newText} onChange={setNewText} testId="uloha-new-emoji" disabled={creating} />
          <button type="button" className="btn good sm" onClick={addTask} disabled={newText.trim() === "" || creating} data-testid="uloha-new-add">
            + Pridať
          </button>
        </>
      )}
    </div>
  );

  const recorderError = recorder.error !== "" && (
    <p role="alert" data-testid="uloha-rec-error">
      {recorder.error}
    </p>
  );

  if (error !== "" && rows === null) {
    return (
      <section>
        {intro}
        <div className="ulohy-panel">
          {addRow}
          {recorderError}
          <p role="alert">{error}</p>
        </div>
      </section>
    );
  }
  if (rows === null) {
    return (
      <section>
        {intro}
        <div className="ulohy-panel">
          {addRow}
          {recorderError}
          <p>Načítavam…</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      {intro}
      <div className="ulohy-panel">
        {addRow}
        {recorderError}
        {error !== "" && <p role="alert">{error}</p>}

        {rows.length === 0 ? (
          <p data-testid="ulohy-empty">Žiadne úlohy — napíš prvú vyššie.</p>
        ) : (
          <div className="ulohy-list" data-testid="ulohy-list">
            {rows.map((row) => (
              <DailyTaskRow
                key={row.id}
                row={row}
                busy={busyId === row.id}
                editing={editingTextId === row.id}
                draftValue={textDraft[row.id] ?? row.text}
                editInputRef={editTextRef}
                onToggleDone={toggleDone}
                onOpenTextEditor={openTextEditor}
                onDraftChange={(value) => {
                  onDraftChange(row.id, value);
                }}
                onSaveText={saveText}
                onCancelEdit={cancelEdit}
                onSaveRowEmoji={saveRowEmoji}
                onRemove={removeTask}
                onDeleteAudio={removeAudio}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
