import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { createNote, deleteNote, fetchNotes, NotesUnauthorizedError, setNoteResolved, type NoteRow } from "../notesApi.js";
import { EmojiPickerButton } from "./EmojiPickerButton.js";
import { IconButton } from "./section/IconButton.js";
import { SectionShell } from "./section/SectionShell.js";

// issue 437: "Poznámky" — ZDIEĽANÁ nástenka rýchlych poznámok (mobilný zápis +
// PWA). Rovnako ako `DailyTasksSection.tsx` (od #487 tiež zdieľaný) sú
// poznámky zdieľané: každý prihlásený ich vidí, autor je
// zobrazený, a ktokoľvek prihlásený môže vybaviť/zmazať (server to tak
// vynucuje — `note-routes.ts`). Preto tu NIE JE žiadne role-podmienené
// ovládanie (Štěpán = rola `sef` musí vedieť pridávať aj spracúvať).
// Komponent prijíma len `onSessionExpired` — TypeScript-ovo stále kompatibilný
// s `ComponentType<SectionProps>` (`nav.ts`), objekt s viac poľami sa dá
// odovzdať tam, kde sa čaká podmnožina (rovnaký vzor ako `DailyTasksSection`).

// Mobile-first: appka je predvolene v Europe/Bratislava, browser použije
// lokálnu TZ používateľa; server posiela UTC ISO. `sk-SK` formát „d.M.yyyy,
// HH:mm" je krátky a čitateľný na telefóne.
function formatCas(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("sk-SK", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function NotesSection({ onSessionExpired }: { readonly onSessionExpired: () => void }): JSX.Element {
  const [rows, setRows] = useState<readonly NoteRow[] | null>(null);
  const [error, setError] = useState("");
  const [newBody, setNewBody] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState("");
  // issue 440: emoji picker vkladá na pozíciu kurzora tohto poľa.
  const newBodyRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(() => {
    fetchNotes()
      .then((data) => {
        setRows(data);
      })
      .catch((err: unknown) => {
        if (err instanceof NotesUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Poznámky sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(() => {
    load();
  }, [load]);

  // Každá mutácia (nielen počiatočný `load()`) rozlišuje vypršanú reláciu
  // (401) od bežného zlyhania — rovnaký vzor ako `DailyTasksSection.tsx`.
  const handleActionError = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof NotesUnauthorizedError) {
        onSessionExpired();
        return;
      }
      setError(fallback);
    },
    [onSessionExpired],
  );

  const addNote = useCallback(() => {
    const body = newBody.trim();
    if (body === "" || creating) return;
    setCreating(true);
    setError("");
    createNote(body)
      .then(() => {
        setNewBody("");
        load();
      })
      .catch((err: unknown) => {
        handleActionError(err, "Poznámku sa nepodarilo uložiť — skúste to znova.");
      })
      .finally(() => {
        setCreating(false);
      });
  }, [newBody, creating, load, handleActionError]);

  const toggleResolved = useCallback(
    (row: NoteRow) => {
      setBusyId(row.id);
      setError("");
      setNoteResolved(row.id, row.resolvedAt === null)
        .then(() => {
          load();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Akcia zlyhala — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError],
  );

  const removeNote = useCallback(
    (id: string) => {
      setBusyId(id);
      setError("");
      deleteNote(id)
        .then(() => {
          load();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Poznámku sa nepodarilo odstrániť — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError],
  );

  const intro = <p>Zdieľané poznámky — napíš myšlienku, ako ťa napadne. Vidia ich všetci prihlásení, spracujte ich spoločne.</p>;

  const addRow = (
    <div className="poznamky-add">
      <textarea
        ref={newBodyRef}
        className="poznamka-new-input"
        value={newBody}
        onChange={(e) => {
          setNewBody(e.target.value);
        }}
        aria-label="Nová poznámka"
        placeholder="Napíš poznámku…"
        data-testid="poznamka-new-input"
        rows={3}
        disabled={creating}
      />
      <div className="poznamka-add-actions">
        <EmojiPickerButton targetRef={newBodyRef} value={newBody} onChange={setNewBody} testId="poznamka-emoji" disabled={creating} />
        <button type="button" className="btn good" onClick={addNote} disabled={newBody.trim() === "" || creating} data-testid="poznamka-new-save">
          Uložiť
        </button>
      </div>
    </div>
  );

  // issue 548 (PR D): zdieľaná kostra `SectionShell` (koreň `section.orders-section`)
  // + jednotné stavové sloty. Layout (intro + add-row) sa kreslí VŽDY, až potom
  // stav, preto `SectionShell` slúži len ako KOREŇ a načítavanie/prázdno sú inline
  // (`.loading role=status` / `p.empty`) — rovnaký vzor ako PR C pri Predajni.
  // Poradie a všetky testidy zachované.
  return (
    <SectionShell>
      {intro}
      <div className="poznamky-panel">
        {addRow}
        {error !== "" && <p role="alert">{error}</p>}

        {rows === null ? (
          error === "" && (
            <p className="loading" role="status">
              Načítavam…
            </p>
          )
        ) : rows.length === 0 ? (
          <p className="empty" data-testid="poznamky-empty">
            Žiadne poznámky — napíš prvú vyššie.
          </p>
        ) : (
          <div className="poznamky-list" data-testid="poznamky-list">
            {rows.map((row) => {
              const isResolved = row.resolvedAt !== null;
              const busy = busyId === row.id;
              return (
                <div className={"poznamka-row" + (isResolved ? " done" : "")} key={row.id} data-testid={`poznamka-row-${row.id}`}>
                  <input
                    type="checkbox"
                    className="poznamka-resolve-toggle"
                    checked={isResolved}
                    aria-label={isResolved ? "Označiť ako nevybavené" : "Označiť ako vybavené"}
                    title={isResolved ? "Označiť ako nevybavené" : "Označiť ako vybavené"}
                    disabled={busy}
                    onChange={() => {
                      toggleResolved(row);
                    }}
                    data-testid={`poznamka-resolve-${row.id}`}
                  />

                  <div className="poznamka-content">
                    <div className="poznamka-body" data-testid={`poznamka-body-${row.id}`}>
                      {row.body}
                    </div>
                    <div className="poznamka-meta" data-testid={`poznamka-meta-${row.id}`}>
                      {row.authorName} · {formatCas(row.createdAt)}
                    </div>
                  </div>

                  <IconButton
                    className="poznamka-icon-btn"
                    disabled={busy}
                    onClick={() => {
                      removeNote(row.id);
                    }}
                    title="Odstrániť poznámku"
                    ariaLabel={`Odstrániť poznámku ${row.body}`}
                    testId={`poznamka-delete-${row.id}`}
                  >
                    🗑
                  </IconButton>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SectionShell>
  );
}
