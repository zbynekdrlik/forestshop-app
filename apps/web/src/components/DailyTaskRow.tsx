import { useRef, useState, type JSX, type RefObject } from "react";
import { dailyTaskAudioUrl, type DailyTaskRow as DailyTaskRowData } from "../dailyTasksApi.js";
import { formatRecordingTime } from "../useVoiceRecorder.js";
import { EmojiPickerButton } from "./EmojiPickerButton.js";

// issue 519: per-riadok rendering „Úloh na dnes" vyčlenený z `DailyTasksSection`
// (eslint `max-lines: 400`, `.claude/rules/frontend-design.md` — pull out the
// repeated per-item rendering unit). Nesie aj ovládanie hlasovej nahrávky
// (prehrať / dĺžka / zmazať nahrávku). Rodič ostáva vlastníkom dát/stavu.

export interface DailyTaskRowProps {
  readonly row: DailyTaskRowData;
  readonly busy: boolean;
  readonly editing: boolean;
  readonly draftValue: string;
  readonly editInputRef: RefObject<HTMLInputElement | null>;
  readonly onToggleDone: (row: DailyTaskRowData) => void;
  readonly onOpenTextEditor: (row: DailyTaskRowData) => void;
  readonly onDraftChange: (value: string) => void;
  readonly onSaveText: (id: string) => void;
  readonly onCancelEdit: () => void;
  readonly onSaveRowEmoji: (id: string, emoji: string | null) => void;
  readonly onRemove: (id: string) => void;
  readonly onDeleteAudio: (id: string) => void;
}

export function DailyTaskRow(props: DailyTaskRowProps): JSX.Element {
  const { row, busy, editing, draftValue, editInputRef } = props;
  const isDone = row.doneAt !== null;

  // Prehrávanie nahrávky — lokálny stav riadku. `preload="none"` (nesťahuje sa,
  // kým používateľ neklikne prehrať). `onError` sa spustí len pri reálnom
  // pokuse o prehratie (cross-device: webm/opus z Chrome sa neprehrá v
  // Safari/iOS) — vtedy VIDITEĽNÁ hláška, nikdy tiché zlyhanie.
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);

  const togglePlay = (): void => {
    const el = audioRef.current;
    if (el === null) return;
    if (el.paused) {
      setPlaybackFailed(false);
      const p = el.play() as Promise<void> | undefined;
      if (p !== undefined && typeof p.catch === "function") {
        p.catch(() => {
          setPlaybackFailed(true);
        });
      }
    } else {
      el.pause();
    }
  };

  const durationLabel = row.audioDurationMs !== null ? formatRecordingTime(row.audioDurationMs) : "";

  return (
    <div className={"uloha-row" + (isDone ? " done" : "")} data-testid={`uloha-row-${row.id}`}>
      <input
        type="checkbox"
        className="uloha-done-toggle"
        checked={isDone}
        aria-label={isDone ? "Označiť ako nevybavené" : "Označiť ako vybavené"}
        title={isDone ? "Označiť ako nevybavené" : "Označiť ako vybavené"}
        disabled={busy}
        onChange={() => {
          props.onToggleDone(row);
        }}
        data-testid={`uloha-done-${row.id}`}
      />

      {row.emoji !== null && (
        <span className="uloha-emoji" data-testid={`uloha-emoji-cell-${row.id}`} aria-hidden="true">
          {row.emoji}
        </span>
      )}

      {editing ? (
        <>
          <input
            ref={editInputRef}
            className="uloha-edit-input"
            value={draftValue}
            onChange={(e) => {
              props.onDraftChange(e.target.value);
            }}
            aria-label="Upraviť text úlohy"
            data-testid={`uloha-edit-input-${row.id}`}
            autoFocus
          />
          {/* issue 471: emoji DO textu aj v edit režime (insert na kurzor). */}
          <EmojiPickerButton
            targetRef={editInputRef}
            value={draftValue}
            onChange={(v) => {
              props.onDraftChange(v);
            }}
            testId={`uloha-edit-emoji-${row.id}`}
            disabled={busy}
          />
          <button
            type="button"
            className="uloha-icon-btn"
            disabled={busy}
            onClick={() => {
              props.onSaveText(row.id);
            }}
            title="Uložiť"
            aria-label="Uložiť text"
            data-testid={`uloha-edit-save-${row.id}`}
          >
            💾
          </button>
          <button
            type="button"
            className="uloha-icon-btn"
            onClick={() => {
              props.onCancelEdit();
            }}
            title="Zrušiť"
            aria-label="Zrušiť úpravu textu"
          >
            ✕
          </button>
        </>
      ) : (
        <>
          <span className="uloha-text" data-testid={`uloha-text-${row.id}`}>
            {row.text}
          </span>
          {/* issue 487: zdieľaný zoznam — autor úlohy pri riadku (ako pri
              Poznámkach), aby bolo jasné, čí je záznam. */}
          <span className="uloha-author" data-testid={`uloha-author-${row.id}`}>
            {row.authorName}
          </span>
        </>
      )}

      {/* issue 519: hlasová nahrávka — prehrať / dĺžka / zmazať nahrávku. */}
      {row.hasAudio && !editing && (
        <span className="uloha-audio" data-testid={`uloha-audio-${row.id}`}>
          <audio
            ref={audioRef}
            src={dailyTaskAudioUrl(row.id)}
            preload="none"
            onPlay={() => {
              setPlaying(true);
            }}
            onPause={() => {
              setPlaying(false);
            }}
            onEnded={() => {
              setPlaying(false);
            }}
            onError={() => {
              setPlaybackFailed(true);
            }}
            data-testid={`uloha-audio-el-${row.id}`}
          />
          <button
            type="button"
            className="uloha-icon-btn"
            onClick={togglePlay}
            title={playing ? "Pozastaviť" : "Prehrať hlasovú poznámku"}
            aria-label={playing ? "Pozastaviť nahrávku" : "Prehrať hlasovú poznámku"}
            data-testid={`uloha-audio-play-${row.id}`}
          >
            {playing ? "⏸" : "▶"}
            {durationLabel !== "" && <span className="uloha-audio-time">{durationLabel}</span>}
          </button>
          {playbackFailed && (
            <span className="uloha-audio-failed" role="alert" data-testid={`uloha-audio-failed-${row.id}`}>
              Prehrávanie zlyhalo
            </span>
          )}
          <button
            type="button"
            className="uloha-icon-btn"
            disabled={busy}
            onClick={() => {
              props.onDeleteAudio(row.id);
            }}
            title="Zmazať nahrávku"
            aria-label="Zmazať hlasovú nahrávku"
            data-testid={`uloha-audio-delete-${row.id}`}
          >
            🗑
          </button>
        </span>
      )}

      {!editing && (
        <div className="uloha-actions">
          <button
            type="button"
            className="uloha-icon-btn"
            onClick={() => {
              props.onOpenTextEditor(row);
            }}
            title="Upraviť text"
            aria-label={`Upraviť text úlohy ${row.text}`}
            data-testid={`uloha-edit-${row.id}`}
          >
            ✏️
          </button>
          {/* issue 471: 😊 otvorí picker, JEDNÝM klikom uloží emoji k úlohe. */}
          <EmojiPickerButton
            onPick={(emoji) => {
              props.onSaveRowEmoji(row.id, emoji);
            }}
            showClear
            align="right"
            label={`Pridať/zmeniť emoji úlohy ${row.text}`}
            title="Pridať/zmeniť emoji"
            testId={`uloha-emoji-${row.id}`}
            disabled={busy}
          />
          <button
            type="button"
            className="uloha-icon-btn"
            disabled={busy}
            onClick={() => {
              props.onRemove(row.id);
            }}
            title="Odstrániť"
            aria-label={`Odstrániť úlohu ${row.text}`}
            data-testid={`uloha-delete-${row.id}`}
          >
            🗑
          </button>
        </div>
      )}
    </div>
  );
}
