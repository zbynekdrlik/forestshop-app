import { useCallback, useContext, useEffect, useRef, useState, type JSX } from "react";
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
import { DailyTasksBadgeRefreshContext } from "../dailyTasksBadgeContext.js";
import { EmojiPickerButton } from "./EmojiPickerButton.js";

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

// Issue 403 (majiteľ: "stale to je otras" — naživo pomenované na tickete):
// tri štrukturálne opravy, žiadna zmena funkčnosti/testid.
// 1) `.ulohy-panel` (JSX nižšie) obmedzuje šírku pridávacieho riadku aj
//    zoznamu na `max-width: 40rem` (app.css) — bez neho sa `.uloha-text`ov
//    `flex:1 1 auto` naťahoval cez CELÚ neohraničenú `<section>` a
//    `.uloha-actions`ov `margin-left:auto` odsúval ikony (✏️😊🗑) na
//    vzdialený pravý okraj, s priemernou nameranou mŕtvou medzerou 771px pri
//    1440px okne (komentár na tickete). Ohraničenie na 40rem (rovnaký
//    ustálený vzor ako `.ord-supplier-link-edit`, issue 162) zníži ju na
//    ~338px bez zmeny riadkovej výšky.
// 2) Prepínač "vybavené" je teraz skutočný `<input type="checkbox">`
//    namiesto `<button>`u s Unicode ☐/☑.
// 3) `.uloha-row`'s `align-items` je `flex-start` namiesto `center`.

// issue 471: emoji picker (zdieľaný `EmojiPickerButton`, issue 440) je zapojený
// na DVE miesta:
//  - INSERT do TEXTU úlohy (nový vstup aj inline edit) — vloženie na kurzor,
//    presne ako Poznámky/Upozornenia.
//  - PICK na označenie CELÉHO riadku — klik na 😊 otvorí picker a JEDNÝM klikom
//    sa emoji rovno uloží (`PATCH …/emoji`); voľba „bez emoji" ho odstráni.
//    Nahradilo pôvodný medzikrok s textovým poľom + Uložiť (issue 342/381),
//    ktorý Štěpán opísal ako nepoužiteľný.

export function DailyTasksSection({ onSessionExpired }: { readonly onSessionExpired: () => void }): JSX.Element {
  const [rows, setRows] = useState<readonly DailyTaskRow[] | null>(null);
  const [error, setError] = useState("");
  const [newText, setNewText] = useState("");
  const [busyId, setBusyId] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<Record<string, string>>({});

  // issue 473: po každej count-meniacej mutácii (pridať/odfajknúť/zmazať) sa
  // zavolá `refresh()` z `DailyTasksBadgeRefreshContext`, aby odznak v ľavom
  // menu (`App.tsx` ho vlastní a fetchuje) klesol/stúpol HNEĎ bez reloadu —
  // rovnaký vzor ako `UpozorneniaSection`. Úprava textu/emoji count NEMENÍ,
  // tie refresh nevolajú.
  const { refresh: badgeRefresh } = useContext(DailyTasksBadgeRefreshContext);

  // issue 471: emoji picker vkladá na pozíciu kurzora týchto polí. Nový vstup má
  // vlastný ref; inline edit má JEDEN zdieľaný ref — appka dovolí najviac jeden
  // riadok v editácii textu naraz, takže je namountované vždy najviac jedno pole.
  const newTextRef = useRef<HTMLInputElement>(null);
  const editTextRef = useRef<HTMLInputElement>(null);

  // Code review (rovnaký nález ako issue 251's `SupplierLinksSection.tsx`/
  // `PairingSection.tsx`): `saveText`'s `.then()` musí vedieť, KTORÝ riadok je
  // PRÁVE editovaný V OKAMIHU, keď odpoveď doletí — nie ten, čo bol editovaný
  // v momente kliknutia na Uložiť. Bez tohto by uloženie riadku A (ešte
  // čakajúce na odpoveď) mohlo zavrieť editor riadku B, otvorený medzitým.
  // "Latest ref" vzor — synchrónne priamo v tele komponentu, nie cez
  // `useEffect`.
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
        badgeRefresh();
      })
      .catch((err: unknown) => {
        handleActionError(err, "Úlohu sa nepodarilo pridať — skúste to znova.");
      })
      .finally(() => {
        setCreating(false);
      });
  }, [newText, creating, load, handleActionError, badgeRefresh]);

  const toggleDone = useCallback(
    (row: DailyTaskRow) => {
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

  // issue 471: jednoklikové označenie riadku — picker zavolá toto priamo s
  // vybraným emoji (alebo `null` pri voľbe „bez emoji"). Žiadny draft ani
  // medzikrokové textové pole; picker si popover zatvorí sám.
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

  const openTextEditor = useCallback((row: DailyTaskRow) => {
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

  const intro = <p>Osobný zoznam úloh — nahrádza poznámky písané do Discordu. Vidíš len svoje vlastné úlohy.</p>;

  const addRow = (
    <div className="ulohy-add-row">
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
      <EmojiPickerButton targetRef={newTextRef} value={newText} onChange={setNewText} testId="uloha-new-emoji" disabled={creating} />
      <button type="button" className="btn good sm" onClick={addTask} disabled={newText.trim() === "" || creating} data-testid="uloha-new-add">
        + Pridať
      </button>
    </div>
  );

  if (error !== "" && rows === null) {
    return (
      <section>
        {intro}
        <div className="ulohy-panel">
          {addRow}
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
                  <input
                    type="checkbox"
                    className="uloha-done-toggle"
                    checked={isDone}
                    aria-label={isDone ? "Označiť ako nevybavené" : "Označiť ako vybavené"}
                    title={isDone ? "Označiť ako nevybavené" : "Označiť ako vybavené"}
                    disabled={busy}
                    onChange={() => {
                      toggleDone(row);
                    }}
                    data-testid={`uloha-done-${row.id}`}
                  />

                  {row.emoji !== null && (
                    <span className="uloha-emoji" data-testid={`uloha-emoji-cell-${row.id}`} aria-hidden="true">
                      {row.emoji}
                    </span>
                  )}

                  {editingTextId === row.id ? (
                    <>
                      <input
                        ref={editTextRef}
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
                      {/* issue 471: emoji DO textu aj v edit režime (insert na kurzor). */}
                      <EmojiPickerButton
                        targetRef={editTextRef}
                        value={textDraft[row.id] ?? row.text}
                        onChange={(v) => {
                          setTextDraft((d) => ({ ...d, [row.id]: v }));
                        }}
                        testId={`uloha-edit-emoji-${row.id}`}
                        disabled={busy}
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

                  {editingTextId !== row.id && (
                    <div className="uloha-actions">
                      <button
                        type="button"
                        className="uloha-icon-btn"
                        onClick={() => {
                          openTextEditor(row);
                        }}
                        title="Upraviť text"
                        aria-label={`Upraviť text úlohy ${row.text}`}
                        data-testid={`uloha-edit-${row.id}`}
                      >
                        ✏️
                      </button>
                      {/* issue 471: 😊 otvorí picker, JEDNÝM klikom uloží emoji k úlohe
                          (`saveRowEmoji`); voľba „bez emoji" ho odstráni. `align="right"`
                          ukotví popover k pravému okraju (picker je pri pravom okraji
                          panela). Vzhľad prepínača je CSS-scopnutý na `.uloha-icon-btn`
                          (`app.css`), takže hustota riadku ostáva rovnaká (issue 471). */}
                      <EmojiPickerButton
                        onPick={(emoji) => {
                          saveRowEmoji(row.id, emoji);
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
      </div>
    </section>
  );
}
