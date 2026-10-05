import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { createNote, deleteNote, fetchNotes, NoteNotFoundError, NotesUnauthorizedError, setNoteResolved, updateNoteText, type NoteRow } from "../notesApi.js";
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
  // issue 591: úprava textu uloženej poznámky v riadku (API vzor Úloh na dnes).
  // Naraz je otvorená najviac JEDNA úprava (`editingId`), rozpísané texty sa
  // však držia PER POZNÁMKA (`drafts`) — keď zlyhá blur-uloženie poznámky A,
  // ktoré prebehlo práve preto, že používateľ klikol na poznámku B, text A sa
  // nestratí a po znovuotvorení A sa vráti (seed-if-absent, `frontend-design.md`
  // issue 381). `editingIdRef` zapisujú VÝHRADNE obsluhy (otvor/zruš/ulož), nie
  // render: `saveEdit`/`cancelEdit` ho synchrónne vynulujú, takže `onBlur`, ktorý
  // prehliadač vystrelí po Enter, počas zápisu (pole je `disabled`), po Esc alebo
  // pri odmontovaní, nájde `null` a neuloží druhýkrát ani zrušenú zmenu.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const editingIdRef = useRef<string | null>(null);

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

  const dropDraft = useCallback((id: string) => {
    setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([key]) => key !== id)));
  }, []);

  const openEditor = useCallback((row: NoteRow) => {
    editingIdRef.current = row.id;
    setDrafts((d) => (row.id in d ? d : { ...d, [row.id]: row.body }));
    setEditingId(row.id);
  }, []);

  const cancelEdit = useCallback(
    (id: string) => {
      editingIdRef.current = null;
      setEditingId(null);
      dropDraft(id);
    },
    [dropDraft],
  );

  // Hodnotu berie z udalosti (živý DOM), nie zo stavu — Enter hneď po písaní
  // tak nikdy neuloží zastaraný text. Prázdny alebo nezmenený text sa neposiela
  // (server by prázdny aj tak odmietol) — úprava sa len zavrie.
  const saveEdit = useCallback(
    (row: NoteRow, value: string) => {
      if (editingIdRef.current !== row.id) return;
      editingIdRef.current = null;
      const body = value.trim();
      if (body === "" || body === row.body) {
        setEditingId(null);
        dropDraft(row.id);
        return;
      }
      setDrafts((d) => ({ ...d, [row.id]: value }));
      setBusyId(row.id);
      setError("");
      // Zavrie LEN túto úpravu — medzitým mohla byť otvorená iná (blur-uloženie
      // prebieha práve vtedy, keď používateľ klikol na inú poznámku).
      const closeThis = () => {
        setEditingId((current) => (current === row.id ? null : current));
      };
      updateNoteText(row.id, body)
        .then(() => {
          // Uložený text hneď v riadku (bez bliknutia starého textu do refetchu).
          setRows((current) => current?.map((r) => (r.id === row.id ? { ...r, body } : r)) ?? current);
          dropDraft(row.id);
          closeThis();
          load();
        })
        .catch((err: unknown) => {
          if (err instanceof NoteNotFoundError) {
            // Poznámku medzitým niekto zmazal — niet čo upravovať, zoznam sa obnoví.
            dropDraft(row.id);
            closeThis();
            setError("Poznámku medzitým niekto zmazal — úprava sa neuložila.");
            load();
            return;
          }
          if (editingIdRef.current === null) {
            // Úprava ostáva otvorená s rozpísaným textom, nech sa dá skúsiť znova.
            editingIdRef.current = row.id;
            handleActionError(err, "Poznámku sa nepodarilo upraviť — skúste to znova.");
            return;
          }
          // Medzitým je otvorená iná poznámka — text tejto ostal v `drafts`.
          handleActionError(err, "Úpravu poznámky sa nepodarilo uložiť — otvor ju znova, rozpísaný text ostal zachovaný.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError, dropDraft],
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
                    {editingId === row.id ? (
                      <textarea
                        className="poznamka-edit-input"
                        value={drafts[row.id] ?? row.body}
                        onChange={(e) => {
                          const value = e.target.value;
                          setDrafts((d) => ({ ...d, [row.id]: value }));
                        }}
                        onKeyDown={(e) => {
                          // Enter uloží, Shift+Enter = nový riadok (poznámka je viacriadková),
                          // Esc zruší. Enter počas skladania znaku (IME, Android klávesnica) nie.
                          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            saveEdit(row, e.currentTarget.value);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEdit(row.id);
                          }
                        }}
                        onFocus={(e) => {
                          // Kurzor na koniec textu — oprava sa najčastejšie dopisuje.
                          const end = e.currentTarget.value.length;
                          e.currentTarget.setSelectionRange(end, end);
                        }}
                        onBlur={(e) => {
                          saveEdit(row, e.currentTarget.value);
                        }}
                        aria-label="Text upravovanej poznámky"
                        data-testid={`poznamka-edit-input-${row.id}`}
                        rows={3}
                        disabled={busy}
                        autoFocus
                      />
                    ) : (
                      <div
                        className="poznamka-body"
                        data-testid={`poznamka-body-${row.id}`}
                        onClick={() => {
                          // Označenie textu (skopírovať telefón/adresu) úpravu neotvorí.
                          if (busy || (window.getSelection()?.toString() ?? "") !== "") return;
                          openEditor(row);
                        }}
                      >
                        {row.body}
                      </div>
                    )}
                    <div className="poznamka-meta" data-testid={`poznamka-meta-${row.id}`}>
                      {row.authorName} · {formatCas(row.createdAt)}
                    </div>
                  </div>

                  {editingId !== row.id && (
                    <IconButton
                      className="poznamka-icon-btn"
                      disabled={busy}
                      onClick={() => {
                        openEditor(row);
                      }}
                      title="Upraviť text"
                      ariaLabel={`Upraviť text poznámky ${row.body}`}
                      testId={`poznamka-edit-${row.id}`}
                    >
                      ✏️
                    </IconButton>
                  )}
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
