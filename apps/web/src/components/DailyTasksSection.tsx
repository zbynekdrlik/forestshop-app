import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  createDailyTask,
  DailyTasksUnauthorizedError,
  deleteDailyTask,
  fetchDailyTasks,
  setDailyTaskDone,
  updateDailyTaskEmoji,
  updateDailyTaskText,
  type DailyTaskRow,
} from "../dailyTasksApi.js";

// issue 342: "Dôležité → Úlohy na dnes" — nahrádza šéfove poznámky písané do
// Discord kanála #úlohy-na-dnes. Na rozdiel od zvyšku appky (viď
// `UpozorneniaSection.tsx`'s `CONTROL_ROLES`) tu NIE JE žiadne
// role-podmienené ovládanie — úlohy sú súkromné pre KAŽDÉHO prihláseného
// používateľa nezávisle od role (server to vynucuje cez `user_id`,
// `daily-tasks-routes.ts`), takže neexistuje dôvod niekomu brániť mať
// vlastný súkromný zoznam. Preto komponent prijíma len `onSessionExpired`,
// nie celý `SectionProps` — TypeScript-ovo je to stále kompatibilné s
// `ComponentType<SectionProps>` (`nav.ts`), lebo objekt s VIAC poľami (role
// navyše) sa dá vždy odovzdať tam, kde sa čaká len podmnožina.

export function DailyTasksSection({ onSessionExpired }: { readonly onSessionExpired: () => void }): JSX.Element {
  const [rows, setRows] = useState<readonly DailyTaskRow[] | null>(null);
  const [error, setError] = useState("");
  const [newText, setNewText] = useState("");
  const [busyId, setBusyId] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<Record<string, string>>({});
  const [editingEmojiId, setEditingEmojiId] = useState<string | null>(null);
  const [emojiDraft, setEmojiDraft] = useState<Record<string, string>>({});

  // Code review (rovnaký nález ako issue 251's `SupplierLinksSection.tsx`/
  // `PairingSection.tsx`): `saveText`/`saveEmoji`'s `.then()` musí vedieť,
  // KTORÝ riadok je PRÁVE editovaný V OKAMIHU, keď odpoveď doletí — nie ten,
  // čo bol editovaný v momente kliknutia na Uložiť. Bez tohto by uloženie
  // riadku A (ešte čakajúce na odpoveď) mohlo zavrieť editor riadku B,
  // otvorený medzitým. "Latest ref" vzor — synchrónne priamo v tele
  // komponentu, nie cez `useEffect`.
  const editingTextIdRef = useRef(editingTextId);
  editingTextIdRef.current = editingTextId;
  const editingEmojiIdRef = useRef(editingEmojiId);
  editingEmojiIdRef.current = editingEmojiId;

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

  // Code review: KAŽDÁ mutácia (nielen počiatočný `load()`) musí rozlíšiť
  // vypršanú reláciu (401) od bežného zlyhania — inak po vypršaní počas
  // akcie appka len opakovane hlási všeobecnú chybu bez cesty späť na
  // prihlásenie. Rovnaký vzor ako `NedostupneSection.tsx`'s každý mutačný
  // `.catch()`.
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
      })
      .catch((err: unknown) => {
        handleActionError(err, "Úlohu sa nepodarilo pridať — skúste to znova.");
      })
      .finally(() => {
        setCreating(false);
      });
  }, [newText, creating, load, handleActionError]);

  const toggleDone = useCallback(
    (row: DailyTaskRow) => {
      setBusyId(row.id);
      setError("");
      setDailyTaskDone(row.id, row.doneAt === null)
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

  const saveText = useCallback(
    (id: string) => {
      const text = (textDraft[id] ?? "").trim();
      if (text === "") return;
      setBusyId(id);
      setError("");
      updateDailyTaskText(id, text)
        .then(() => {
          // Code review: kým táto odpoveď čakala, používateľ mohol otvoriť
          // INÝ riadok na úpravu textu (`editingTextId` sa presunul naň) —
          // vtedy toto zatvorenie NESMIE prebehnúť, inak by ticho zavrelo
          // CUDZÍ, práve rozpísaný editor.
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

  const saveEmoji = useCallback(
    (id: string) => {
      const emoji = (emojiDraft[id] ?? "").trim();
      setBusyId(id);
      setError("");
      updateDailyTaskEmoji(id, emoji === "" ? null : emoji)
        .then(() => {
          // Rovnaký dôvod ako `saveText` vyššie — nezavrieť CUDZÍ, medzitým
          // otvorený emoji editor.
          if (editingEmojiIdRef.current === id) setEditingEmojiId(null);
          load();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Emoji sa nepodarilo uložiť — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [emojiDraft, load, handleActionError],
  );

  const removeTask = useCallback(
    (id: string) => {
      setBusyId(id);
      setError("");
      deleteDailyTask(id)
        .then(() => {
          load();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Úlohu sa nepodarilo odstrániť — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError],
  );

  const intro = <p>Osobný zoznam úloh — nahrádza poznámky písané do Discordu. Vidíš len svoje vlastné úlohy.</p>;

  const addRow = (
    <div className="ulohy-add-row">
      <input
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
      <button type="button" className="btn good sm" onClick={addTask} disabled={newText.trim() === "" || creating} data-testid="uloha-new-add">
        + Pridať
      </button>
    </div>
  );

  if (error !== "" && rows === null) {
    return (
      <section>
        {intro}
        {addRow}
        <p role="alert">{error}</p>
      </section>
    );
  }
  if (rows === null) {
    return (
      <section>
        {intro}
        {addRow}
        <p>Načítavam…</p>
      </section>
    );
  }

  return (
    <section>
      {intro}
      {addRow}
      {error !== "" && <p role="alert">{error}</p>}

      {rows.length === 0 ? (
        <p data-testid="ulohy-empty">Žiadne úlohy — napíš prvú vyššie.</p>
      ) : (
        <div className="ulohy-list" data-testid="ulohy-list">
          {rows.map((row) => {
            const isDone = row.doneAt !== null;
            const busy = busyId === row.id;
            return (
              <div className={"uloha-row" + (isDone ? " done" : "")} key={row.id} data-testid={`uloha-row-${row.id}`}>
                <button
                  type="button"
                  className="uloha-done-toggle"
                  aria-pressed={isDone}
                  aria-label={isDone ? "Označiť ako nevybavené" : "Označiť ako vybavené"}
                  title={isDone ? "Označiť ako nevybavené" : "Označiť ako vybavené"}
                  disabled={busy}
                  onClick={() => {
                    toggleDone(row);
                  }}
                  data-testid={`uloha-done-${row.id}`}
                >
                  {isDone ? "☑" : "☐"}
                </button>

                {row.emoji !== null && editingEmojiId !== row.id && (
                  <span className="uloha-emoji" aria-hidden="true">
                    {row.emoji}
                  </span>
                )}

                {editingTextId === row.id ? (
                  <>
                    <input
                      className="uloha-edit-input"
                      value={textDraft[row.id] ?? row.text}
                      onChange={(e) => {
                        const value = e.target.value;
                        setTextDraft((d) => ({ ...d, [row.id]: value }));
                      }}
                      aria-label="Upraviť text úlohy"
                      data-testid={`uloha-edit-input-${row.id}`}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="uloha-icon-btn"
                      disabled={busy}
                      onClick={() => {
                        saveText(row.id);
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
                        setEditingTextId(null);
                      }}
                      title="Zrušiť"
                      aria-label="Zrušiť úpravu textu"
                    >
                      ✕
                    </button>
                  </>
                ) : (
                  <span className="uloha-text" data-testid={`uloha-text-${row.id}`}>
                    {row.text}
                  </span>
                )}

                {editingEmojiId === row.id && (
                  <>
                    <input
                      className="uloha-emoji-input-field"
                      value={emojiDraft[row.id] ?? row.emoji ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        setEmojiDraft((d) => ({ ...d, [row.id]: value }));
                      }}
                      aria-label="Emoji úlohy"
                      placeholder="😊"
                      data-testid={`uloha-emoji-input-${row.id}`}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="uloha-icon-btn"
                      disabled={busy}
                      onClick={() => {
                        saveEmoji(row.id);
                      }}
                      title="Uložiť emoji"
                      aria-label="Uložiť emoji"
                      data-testid={`uloha-emoji-save-${row.id}`}
                    >
                      💾
                    </button>
                  </>
                )}

                {editingTextId !== row.id && (
                  <div className="uloha-actions">
                    <button
                      type="button"
                      className="uloha-icon-btn"
                      onClick={() => {
                        setTextDraft((d) => ({ ...d, [row.id]: row.text }));
                        setEditingTextId(row.id);
                      }}
                      title="Upraviť text"
                      aria-label={`Upraviť text úlohy ${row.text}`}
                      data-testid={`uloha-edit-${row.id}`}
                    >
                      ✏️
                    </button>
                    {editingEmojiId !== row.id && (
                      <button
                        type="button"
                        className="uloha-icon-btn"
                        onClick={() => {
                          setEmojiDraft((d) => ({ ...d, [row.id]: row.emoji ?? "" }));
                          setEditingEmojiId(row.id);
                        }}
                        title="Pridať/zmeniť emoji"
                        aria-label={`Pridať/zmeniť emoji úlohy ${row.text}`}
                        data-testid={`uloha-emoji-${row.id}`}
                      >
                        😊
                      </button>
                    )}
                    <button
                      type="button"
                      className="uloha-icon-btn"
                      disabled={busy}
                      onClick={() => {
                        removeTask(row.id);
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
          })}
        </div>
      )}
    </section>
  );
}
