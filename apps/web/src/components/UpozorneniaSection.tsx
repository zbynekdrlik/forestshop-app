import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { Me } from "../api.js";
import {
  createOwnNote,
  deleteOwnNote,
  fetchUpozornenia,
  markUpozorneniaSeen,
  postponeUpozornenie,
  resolveUpozornenie,
  updateOwnNote,
  UpozorneniaUnauthorizedError,
  type UpozornenieRow,
} from "../upozorneniaApi.js";

// issue 267: rovnaké dve role, ktoré appka všade inde vyžaduje na zápis
// (`requireRole("admin", "manazer")`, `upozornenia-routes.ts`) — čítanie
// (zoznam) smie vidieť KAŽDÝ prihlásený zamestnanec.
const CONTROL_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

// Otvorený zoznam typov (dnes jediný) — budúci automatický zdroj (#268/#269)
// pridá svoj štítok sem, keď pridá svoju `pgEnum` hodnotu.
const TYPE_LABELS: Readonly<Record<UpozornenieRow["type"], string>> = {
  vlastna_poznamka: "Moja poznámka",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("sk-SK", { day: "numeric", month: "numeric", year: "numeric" });
}

// Code review: "Odložiť do" nemalo `min` — dalo sa vybrať dátum v minulosti
// (neškodné, `computeStatus` by ho vzalo ako "už sa vrátilo", ale mätúce
// no-op). `<input type="date">`'s `min` očakáva `YYYY-MM-DD` v LOKÁLNOM
// čase prehliadača, nie `toISOString()` (tá by okolo polnoci mohla ukázať
// VČEREJŠÍ dátum v časových pásmach východne od UTC).
function todayDateInputValue(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${String(y)}-${m}-${d}`;
}

interface EditDraft {
  readonly id: string | null; // null = nový záznam
  readonly title: string;
  readonly details: string;
  readonly dueAt: string;
}

const EMPTY_DRAFT: EditDraft = { id: null, title: "", details: "", dueAt: "" };

export function UpozorneniaSection({ role, onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  const [rows, setRows] = useState<readonly UpozornenieRow[] | null>(null);
  const [error, setError] = useState("");
  const [includeResolved, setIncludeResolved] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [postponeDraft, setPostponeDraft] = useState<Record<string, string>>({});
  const canControl = CONTROL_ROLES.has(role);

  const load = useCallback(() => {
    fetchUpozornenia({ includeResolved })
      .then(setRows)
      .catch((err: unknown) => {
        if (err instanceof UpozorneniaUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Upozornenia sa nepodarilo načítať.");
      });
  }, [includeResolved, onSessionExpired]);

  // Otvorenie záložky = "prečítané" (inbox vzor) — PRVÉ spustenie tohto
  // efektu (mountedRef ešte `false`) hromadne označí všetky práve "Nové"
  // karty ako videné a AŽ POTOM načíta zoznam (žiadny dvojitý fetch na
  // mount) — žiadne per-kartové tlačidlo "videné" navyše. Každé ĎALŠIE
  // spustenie (zmena `includeResolved`, teda nová identita `load`) už len
  // refetchne, mark-seen sa nezopakuje. `mountedRef` sa nastavuje SYNCHRÓNNE
  // v tele efektu (nie len v `useRef`'s počiatočnej hodnote) — `<StrictMode>`
  // (`main.tsx`) efekt vo vývoji spustí, zruší a znova spustí, presne vzor z
  // `.claude/rules/frontend-design.md`'s "mountedRef POTREBUJE nastaviť true
  // AJ v tele efektu" (issue 251).
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      markUpozorneniaSeen()
        .then(load)
        .catch(() => {
          // Sieťový výpadok pri mark-seen — aspoň bežné načítanie zoznamu.
          load();
        });
      return;
    }
    load();
  }, [load]);

  const withBusy = useCallback((key: string, action: () => Promise<void>) => {
    setBusyId(key);
    setError("");
    action()
      .then(load)
      .catch(() => {
        setError("Akcia zlyhala — skúste to znova.");
      })
      .finally(() => {
        setBusyId("");
      });
  }, [load]);

  const saveDraft = useCallback(() => {
    if (draft === null || draft.title.trim() === "") return;
    const editId = draft.id;
    const input = { title: draft.title.trim(), details: draft.details.trim(), dueAt: draft.dueAt === "" ? null : draft.dueAt };
    setBusyId(editId ?? "new");
    setError("");
    // `updateOwnNote` vracia `false`, keď karta medzitým zmizla (zmazaná
    // iným prihlásením) alebo prestala byť vlastnou poznámkou — obe sú
    // legitímne (nechybové) situácie, nikdy sa NEZAVRIE formulár tak, akoby
    // sa uloženie podarilo.
    const action = editId === null ? createOwnNote(input).then(() => true) : updateOwnNote(editId, input);
    action
      .then((ok) => {
        if (!ok) {
          setError("Upozornenie medzitým zmizlo — obnovte zoznam a skúste to znova.");
          return;
        }
        setDraft(null);
        load();
      })
      .catch(() => {
        setError("Uloženie zlyhalo — skúste to znova.");
      })
      .finally(() => {
        setBusyId("");
      });
  }, [draft, load]);

  if (error !== "" && rows === null) return <p role="alert">{error}</p>;
  if (rows === null) return <p>Načítavam…</p>;

  return (
    <section>
      <p>Veci, ktoré treba vybaviť — nech ich zistila appka sama, alebo si ich zapísal majiteľ. Nič odtiaľto sa neposiela e-mailom ani na Discord.</p>

      {error !== "" && <p role="alert">{error}</p>}

      <div className="upozornenia-toolbar">
        <label>
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(e) => {
              setIncludeResolved(e.target.checked);
            }}
          />{" "}
          aj vybavené
        </label>
        {canControl && (
          <button
            type="button"
            className="btn good"
            onClick={() => {
              setDraft(EMPTY_DRAFT);
            }}
            data-testid="upozornenie-new"
          >
            + Nové upozornenie
          </button>
        )}
      </div>

      {draft !== null && (
        <div className="card upozornenie-form" data-testid="upozornenie-form">
          <label>
            Nadpis
            <input
              value={draft.title}
              onChange={(e) => {
                const value = e.target.value;
                setDraft((d) => (d === null ? d : { ...d, title: value }));
              }}
              aria-label="Nadpis upozornenia"
              data-testid="upozornenie-form-title"
            />
          </label>
          <label>
            Podrobnosti
            <textarea
              value={draft.details}
              onChange={(e) => {
                const value = e.target.value;
                setDraft((d) => (d === null ? d : { ...d, details: value }));
              }}
              aria-label="Podrobnosti upozornenia"
              data-testid="upozornenie-form-details"
            />
          </label>
          <label>
            Vybaviť do (nepovinné)
            <input
              type="date"
              value={draft.dueAt}
              onChange={(e) => {
                const value = e.target.value;
                setDraft((d) => (d === null ? d : { ...d, dueAt: value }));
              }}
              aria-label="Vybaviť do"
              data-testid="upozornenie-form-due"
            />
          </label>
          <div className="upozornenie-form-actions">
            <button type="button" className="btn good" disabled={draft.title.trim() === "" || busyId !== ""} onClick={saveDraft} data-testid="upozornenie-form-save">
              💾 Uložiť
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setDraft(null);
              }}
            >
              Zrušiť
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p data-testid="upozornenia-empty">Žiadne upozornenia — všetko je vybavené.</p>
      ) : (
        <div className="upozornenia-list" data-testid="upozornenia-list">
          {rows.map((row) => {
            const rowBusy = busyId === row.id;
            const isOwn = row.source === "vlastne";
            return (
              <div className={"card upozornenie-card" + (row.status === "nove" ? " upozornenie-nove" : "")} key={row.id} data-testid={`upozornenie-${row.id}`}>
                <div className="upozornenie-head">
                  <span className="pill" data-testid={`upozornenie-type-${row.id}`}>
                    {TYPE_LABELS[row.type]}
                  </span>
                  {row.status === "nove" && <strong data-testid={`upozornenie-nove-${row.id}`}>Nové</strong>}
                  {row.status === "vybavene" && <span className="pill off">Vybavené</span>}
                </div>
                <p className="upozornenie-title">{row.title}</p>
                {row.details !== "" && <p className="upozornenie-details">{row.details}</p>}
                <p className="upozornenie-meta">
                  Vzniklo {formatDate(row.createdAt)}
                  {row.dueAt !== null && <> · vybaviť do {formatDate(row.dueAt)}</>}
                </p>
                {row.link !== null && (
                  <a href={row.link} data-testid={`upozornenie-link-${row.id}`}>
                    Otvoriť v appke
                  </a>
                )}
                {canControl && row.status !== "vybavene" && (
                  <div className="upozornenie-actions">
                    <button
                      type="button"
                      className="btn sm good"
                      disabled={rowBusy}
                      onClick={() => {
                        withBusy(row.id, () => resolveUpozornenie(row.id));
                      }}
                      data-testid={`upozornenie-resolve-${row.id}`}
                    >
                      ✓ Vybavené
                    </button>
                    <input
                      type="date"
                      min={todayDateInputValue()}
                      value={postponeDraft[row.id] ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        setPostponeDraft((d) => ({ ...d, [row.id]: value }));
                      }}
                      aria-label={`Odložiť do — ${row.title}`}
                      data-testid={`upozornenie-postpone-date-${row.id}`}
                    />
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled={rowBusy || (postponeDraft[row.id] ?? "") === ""}
                      onClick={() => {
                        const until = postponeDraft[row.id];
                        if (until === undefined || until === "") return;
                        withBusy(row.id, () => postponeUpozornenie(row.id, new Date(until).toISOString()));
                      }}
                      data-testid={`upozornenie-postpone-${row.id}`}
                    >
                      Odložiť
                    </button>
                    {isOwn && (
                      <>
                        <button
                          type="button"
                          className="btn sm ghost"
                          disabled={rowBusy}
                          onClick={() => {
                            setDraft({ id: row.id, title: row.title, details: row.details, dueAt: row.dueAt === null ? "" : row.dueAt.slice(0, 10) });
                          }}
                          data-testid={`upozornenie-edit-${row.id}`}
                        >
                          Upraviť
                        </button>
                        <button
                          type="button"
                          className="btn sm ghost"
                          disabled={rowBusy}
                          onClick={() => {
                            withBusy(row.id, () => deleteOwnNote(row.id));
                          }}
                          data-testid={`upozornenie-delete-${row.id}`}
                        >
                          ✕ Zmazať
                        </button>
                      </>
                    )}
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
