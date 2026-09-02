import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  createPaymentNote,
  createPaymentScan,
  deletePaymentNote,
  fetchPaymentNotes,
  fetchPaymentScans,
  uhradyScanImageUrl,
  UhradyUnauthorizedError,
  type PaymentNoteRow,
  type PaymentScanRow,
} from "../uhradyApi.js";
import { PaymentScanCard } from "./PaymentScanCard.js";

// issue 543: "SLAVOSPORT → Úhrady" — jednoriadkové poznámky navrchu (ako „Úlohy
// na dnes", ale BEZ hlasu/audio) + upload naskenovaných FA, ktoré treba
// uhradiť, ako grid thumbnailov s popisom; klik zväčší (lightbox), po úhrade sa
// dá zmazať (s potvrdením). VISIBLE tab (`nav.ts`) — NEvykresľuje vlastný
// nadpis, ten renderuje `Topbar` (`.claude/rules/frontend-design.md`). Zdieľané
// (server nevynucuje vlastníctvo) — prijíma len `onSessionExpired`.

function formatCas(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("sk-SK", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function UhradySection({ onSessionExpired }: { readonly onSessionExpired: () => void }): JSX.Element {
  const [notes, setNotes] = useState<readonly PaymentNoteRow[] | null>(null);
  const [scans, setScans] = useState<readonly PaymentScanRow[] | null>(null);
  const [error, setError] = useState("");
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [busyNoteId, setBusyNoteId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<PaymentScanRow | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleActionError = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof UhradyUnauthorizedError) {
        onSessionExpired();
        return;
      }
      setError(fallback);
    },
    [onSessionExpired],
  );

  const loadNotes = useCallback(() => {
    fetchPaymentNotes()
      .then(setNotes)
      .catch((err: unknown) => {
        handleActionError(err, "Poznámky sa nepodarilo načítať.");
      });
  }, [handleActionError]);

  const loadScans = useCallback(() => {
    fetchPaymentScans()
      .then(setScans)
      .catch((err: unknown) => {
        handleActionError(err, "Skeny sa nepodarilo načítať.");
      });
  }, [handleActionError]);

  useEffect(() => {
    loadNotes();
    loadScans();
  }, [loadNotes, loadScans]);

  const addNote = useCallback(() => {
    const text = newNote.trim();
    if (text === "" || addingNote) return;
    setAddingNote(true);
    setError("");
    createPaymentNote(text)
      .then(() => {
        setNewNote("");
        loadNotes();
      })
      .catch((err: unknown) => {
        handleActionError(err, "Poznámku sa nepodarilo pridať — skúste to znova.");
      })
      .finally(() => {
        setAddingNote(false);
      });
  }, [newNote, addingNote, loadNotes, handleActionError]);

  const removeNote = useCallback(
    (id: string) => {
      setBusyNoteId(id);
      setError("");
      deletePaymentNote(id)
        .then(() => {
          loadNotes();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Poznámku sa nepodarilo odstrániť — skúste to znova.");
        })
        .finally(() => {
          setBusyNoteId("");
        });
    },
    [loadNotes, handleActionError],
  );

  const uploadFiles = useCallback(
    (files: FileList) => {
      const list = Array.from(files);
      if (list.length === 0 || uploading) return;
      setUploading(true);
      setError("");
      // Nahraj postupne (sekvenčne) — jednoduché a šetrné k 2-jadrovému boxu.
      void (async () => {
        try {
          for (const file of list) {
            await createPaymentScan(file, "");
          }
          loadScans();
        } catch (err: unknown) {
          handleActionError(err, "Sken sa nepodarilo uložiť — skúste to znova.");
        } finally {
          setUploading(false);
          if (fileInputRef.current !== null) fileInputRef.current.value = "";
        }
      })();
    },
    [uploading, loadScans, handleActionError],
  );

  const onDescriptionSaved = useCallback((id: string, description: string) => {
    setScans((prev) => (prev === null ? prev : prev.map((s) => (s.id === id ? { ...s, description } : s))));
  }, []);

  const onScanDeleted = useCallback((id: string) => {
    setScans((prev) => (prev === null ? prev : prev.filter((s) => s.id !== id)));
    setLightbox((prev) => (prev !== null && prev.id === id ? null : prev));
  }, []);

  // Lightbox: zavri klávesom Esc, kým je otvorený.
  useEffect(() => {
    if (lightbox === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [lightbox]);

  const intro = <p>Naskenované papierové faktúry na úhradu a rýchle poznámky. Po úhrade sken zmaž. Vidia to všetci prihlásení.</p>;

  const noteAddRow = (
    <div className="uhrady-note-add" data-testid="uhrady-note-add-row">
      <input
        type="text"
        className="uhrady-note-input"
        value={newNote}
        onChange={(e) => {
          setNewNote(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addNote();
          }
        }}
        aria-label="Nová poznámka"
        placeholder="Napíš poznámku a stlač Enter…"
        maxLength={300}
        disabled={addingNote}
        data-testid="uhrady-note-input"
      />
      <button type="button" className="btn good" onClick={addNote} disabled={newNote.trim() === "" || addingNote} data-testid="uhrady-note-add">
        Pridať
      </button>
    </div>
  );

  return (
    <section className="uhrady">
      {intro}
      {error !== "" && <p role="alert">{error}</p>}

      <div className="uhrady-notes-panel">
        {noteAddRow}
        {notes === null ? (
          <p>Načítavam…</p>
        ) : notes.length === 0 ? (
          <p data-testid="uhrady-notes-empty">Žiadne poznámky — napíš prvú vyššie.</p>
        ) : (
          <div className="uhrady-notes-list" data-testid="uhrady-notes-list">
            {notes.map((row) => {
              const busy = busyNoteId === row.id;
              return (
                <div className="uhrady-note-row" key={row.id} data-testid={`uhrady-note-${row.id}`}>
                  <div className="uhrady-note-content">
                    <div className="uhrady-note-text">{row.text}</div>
                    <div className="uhrady-note-meta">
                      {row.authorName} · {formatCas(row.createdAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="uhrady-note-delete"
                    disabled={busy}
                    onClick={() => {
                      removeNote(row.id);
                    }}
                    title="Odstrániť poznámku"
                    aria-label={`Odstrániť poznámku ${row.text}`}
                    data-testid={`uhrady-note-delete-${row.id}`}
                  >
                    🗑
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <h2 className="uhrady-upload-heading">Nahrať súbor</h2>
      <div className="uhrady-upload">
        <input
          ref={fileInputRef}
          type="file"
          className="uhrady-file-input"
          accept="image/jpeg,image/png"
          multiple
          disabled={uploading}
          onChange={(e) => {
            if (e.target.files !== null) uploadFiles(e.target.files);
          }}
          aria-label="Nahrať naskenovanú faktúru (JPG alebo PNG)"
          data-testid="uhrady-file-input"
        />
        {uploading && <span className="uhrady-uploading" data-testid="uhrady-uploading">Nahrávam…</span>}
      </div>

      {scans === null ? (
        <p>Načítavam skeny…</p>
      ) : scans.length === 0 ? (
        <p data-testid="uhrady-scans-empty">Zatiaľ žiadne naskenované faktúry — nahraj prvú vyššie.</p>
      ) : (
        <div className="uhrady-scan-grid" data-testid="uhrady-scan-grid">
          {scans.map((scan) => (
            <PaymentScanCard
              key={scan.id}
              scan={scan}
              onOpenLightbox={setLightbox}
              onDescriptionSaved={onDescriptionSaved}
              onDeleted={onScanDeleted}
              onError={handleActionError}
            />
          ))}
        </div>
      )}

      {lightbox !== null && (
        <div
          className="uhrady-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Zväčšený sken faktúry"
          data-testid="uhrady-lightbox"
          onClick={() => {
            setLightbox(null);
          }}
        >
          <button
            type="button"
            className="uhrady-lightbox-close"
            onClick={() => {
              setLightbox(null);
            }}
            aria-label="Zavrieť"
            data-testid="uhrady-lightbox-close"
          >
            ✕
          </button>
          <img
            className="uhrady-lightbox-img"
            src={uhradyScanImageUrl(lightbox.id)}
            alt={lightbox.description === "" ? "Naskenovaná faktúra" : lightbox.description}
            onClick={(e) => {
              e.stopPropagation();
            }}
          />
        </div>
      )}
    </section>
  );
}
