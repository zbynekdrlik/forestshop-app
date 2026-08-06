import { useCallback, useContext, useEffect, useRef, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { UpozorneniaBadgeRefreshContext } from "../upozorneniaBadgeContext.js";
import { UpozornenieCard } from "./UpozornenieCard.js";
import { UpozorneniaResolvedList } from "./UpozorneniaResolvedList.js";
import {
  cancelPostponeUpozornenie,
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

// issue 267 (živé overenie, gap 3): prázdny zoznam tvrdil natvrdo "všetko je
// vybavené" bez ohľadu na SKUTOČNÚ príčinu — čistá funkcia rozhodne podľa
// NAJŠIRŠIEHO dopytu (volaného len keď je aktuálny, možno UŽŠIE filtrovaný
// zoznam prázdny — pozri `load()`), aby hláška nikdy netvrdila niečo, čo
// nie je pravda.
function classifyEmptyMessage(all: readonly UpozornenieRow[]): string {
  if (all.length === 0) return "Žiadne upozornenia — nič nie je zapísané.";
  if (all.every((r) => r.status === "vybavene")) return "Žiadne upozornenia — všetko je vybavené.";
  if (all.every((r) => r.status === "odlozene")) return "Žiadne upozornenia — všetko je odložené.";
  return "Žiadne upozornenia v tomto zobrazení — zvyšné sú vybavené alebo odložené.";
}

interface EditDraft {
  readonly id: string | null; // null = nový záznam
  readonly title: string;
  readonly details: string;
  readonly dueAt: string;
}

const EMPTY_DRAFT: EditDraft = { id: null, title: "", details: "", dueAt: "" };

export function UpozorneniaSection({ role, onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  // issue 283 (majiteľ, komentár na tickete): záložka "Vybavené" — predvolená
  // ostáva "otvorene" presne ako ticket žiada ("Keep the existing view as
  // the default").
  const [activeTab, setActiveTab] = useState<"otvorene" | "vybavene">("otvorene");
  const [rows, setRows] = useState<readonly UpozornenieRow[] | null>(null);
  const [error, setError] = useState("");
  // issue 267 (živé overenie, gap 2): nezávislý filter od vyriešených kariet
  // — odložená karta bola bez tohto NAVŽDY skrytá.
  const [includePostponed, setIncludePostponed] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [postponeDraft, setPostponeDraft] = useState<Record<string, string>>({});
  // issue 267 (živé overenie, gap 3): pravdivá príčina prázdneho zoznamu —
  // počíta sa v `load()` nižšie, len keď je zoznam skutočne prázdny.
  const [emptyMessage, setEmptyMessage] = useState("Žiadne upozornenia.");
  const canControl = CONTROL_ROLES.has(role);
  // issue 267 (živé overenie, gap 1): odznak v ľavom menu (`App.tsx`) sa bez
  // tohto refetchoval len pri zmene záložky — refresh() sa zavolá po KAŽDEJ
  // úspešnej mutácii (`withBusy`/`saveDraft`), aby ostal pravdivý aj keď
  // obsluha zostane na tejto obrazovke.
  const { refresh: refreshBadge } = useContext(UpozorneniaBadgeRefreshContext);
  // Code review: `load()`'s doplnkový klasifikačný dopyt (nižšie) nemal
  // žiadnu poistku proti ZASTARANEJ odpovedi — presne tá istá trieda race,
  // akú `.claude/rules/frontend-design.md` rieši "latest ref" vzorom (issue
  // 151/251/264: mikrotaska z PREDCHÁDZAJÚCEHO `load()` volania môže
  // doraziť AŽ PO novšom a prepísať jeho výsledok zastaraným). `loadSeqRef`
  // sa inkrementuje na ZAČIATKU každého `load()` volania; oba `.then()` nižšie
  // sa uplatnia len ak je stále najnovšie.
  const loadSeqRef = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeqRef.current;
    // issue 283 (Vybavené záložka nahradila checkbox "aj vybavené"): tento
    // zoznam už NIKDY nesmie ukázať vyriešenú kartu — `includeResolved` je
    // preto vždy `false`, nie ovládané žiadnym filtrom.
    fetchUpozornenia({ includeResolved: false, includePostponed })
      .then((data) => {
        if (loadSeqRef.current !== seq) return;
        setRows(data);
        if (data.length > 0) return;
        // Zoznam je prázdny pod AKTUÁLNYMI (možno užšími) filtrami — treba
        // doplnkový najširší dopyt, aby hláška nikdy nehádala/netvrdila
        // nesprávnu príčinu (napr. "všetko je vybavené", hoci je len
        // odložené).
        fetchUpozornenia({ includeResolved: true, includePostponed: true })
          .then((all) => {
            if (loadSeqRef.current === seq) setEmptyMessage(classifyEmptyMessage(all));
          })
          .catch(() => {
            if (loadSeqRef.current === seq) setEmptyMessage("Žiadne upozornenia v tomto zobrazení.");
          });
      })
      .catch((err: unknown) => {
        if (loadSeqRef.current !== seq) return;
        if (err instanceof UpozorneniaUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Upozornenia sa nepodarilo načítať.");
      });
  }, [includePostponed, onSessionExpired]);

  // Otvorenie záložky = "prečítané" (inbox vzor) — PRVÉ spustenie tohto
  // efektu (mountedRef ešte `false`) hromadne označí všetky práve "Nové"
  // karty ako videné a AŽ POTOM načíta zoznam (žiadny dvojitý fetch na
  // mount) — žiadne per-kartové tlačidlo "videné" navyše. Každé ĎALŠIE
  // spustenie (zmena `includePostponed`, teda nová identita `load`) už len
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
      .then(() => {
        load();
        refreshBadge();
      })
      .catch(() => {
        setError("Akcia zlyhala — skúste to znova.");
      })
      .finally(() => {
        setBusyId("");
      });
  }, [load, refreshBadge]);

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
        refreshBadge();
      })
      .catch(() => {
        setError("Uloženie zlyhalo — skúste to znova.");
      })
      .finally(() => {
        setBusyId("");
      });
  }, [draft, load, refreshBadge]);

  // Code review (issue 283): pôvodná verzia gatovala CELÚ sekciu (vrátane
  // samotného prepínača záložiek) na `rows === null`/`error` — teda kým
  // "Otvorené" ešte len načítavalo (alebo sieťovo zlyhalo), obsluha sa
  // NEDOSTALA ani k záložke "Vybavené", hoci tá je nezávislá a mohla by sa
  // pokojne otvoriť. `intro`/`tabBar` sa preto renderujú VŽDY, nezávisle od
  // `rows`/`error` — tie patria LEN vetve `activeTab === "otvorene"`.
  const intro = <p>Veci, ktoré treba vybaviť — nech ich zistila appka sama, alebo si ich zapísal majiteľ. Nič odtiaľto sa neposiela e-mailom ani na Discord.</p>;
  const tabBar = (
    <div className="upozornenia-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "otvorene"}
        className={"upozornenia-tab" + (activeTab === "otvorene" ? " active" : "")}
        onClick={() => {
          setActiveTab("otvorene");
        }}
        data-testid="upozornenia-tab-otvorene"
      >
        Otvorené
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "vybavene"}
        className={"upozornenia-tab" + (activeTab === "vybavene" ? " active" : "")}
        onClick={() => {
          setActiveTab("vybavene");
        }}
        data-testid="upozornenia-tab-vybavene"
      >
        Vybavené
      </button>
    </div>
  );

  if (activeTab === "vybavene") {
    return (
      <section>
        {intro}
        {tabBar}
        <UpozorneniaResolvedList
          canControl={canControl}
          onSessionExpired={onSessionExpired}
          onReturnedToOpen={() => {
            load();
            refreshBadge();
          }}
        />
      </section>
    );
  }

  // Odtiaľto `activeTab === "otvorene"` — `rows`/`error` (patriace LEN
  // tomuto zoznamu) sa smú vyhodnotiť.
  if (error !== "" && rows === null) {
    return (
      <section>
        {intro}
        {tabBar}
        <p role="alert">{error}</p>
      </section>
    );
  }
  if (rows === null) {
    return (
      <section>
        {intro}
        {tabBar}
        <p>Načítavam…</p>
      </section>
    );
  }

  return (
    <section>
      {intro}
      {tabBar}
      {error !== "" && <p role="alert">{error}</p>}

      <div className="upozornenia-toolbar">
        <label>
          <input
            type="checkbox"
            checked={includePostponed}
            onChange={(e) => {
              setIncludePostponed(e.target.checked);
            }}
          />{" "}
          aj odložené
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
        <p data-testid="upozornenia-empty">{emptyMessage}</p>
      ) : (
        <div className="upozornenia-list" data-testid="upozornenia-list">
          {rows.map((row) => (
            <UpozornenieCard
              key={row.id}
              row={row}
              canControl={canControl}
              busy={busyId === row.id}
              postponeDraftValue={postponeDraft[row.id] ?? ""}
              onPostponeDraftChange={(value) => {
                setPostponeDraft((d) => ({ ...d, [row.id]: value }));
              }}
              onResolve={() => {
                withBusy(row.id, () => resolveUpozornenie(row.id));
              }}
              onPostpone={() => {
                const until = postponeDraft[row.id];
                if (until === undefined || until === "") return;
                withBusy(row.id, () => postponeUpozornenie(row.id, new Date(until).toISOString()));
              }}
              onCancelPostpone={() => {
                withBusy(row.id, () => cancelPostponeUpozornenie(row.id));
              }}
              onEdit={() => {
                setDraft({ id: row.id, title: row.title, details: row.details, dueAt: row.dueAt === null ? "" : row.dueAt.slice(0, 10) });
              }}
              onDelete={() => {
                withBusy(row.id, () => deleteOwnNote(row.id));
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
