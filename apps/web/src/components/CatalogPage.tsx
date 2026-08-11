import { useCallback, useEffect, useRef, useState, type SyntheticEvent, type JSX } from "react";
import type { Me } from "../api.js";
import { formatSkDate, formatSkDateTime } from "../formatDate.js";
import {
  CatalogUnauthorizedError,
  fetchCatalogStats,
  searchCatalogVariants,
  triggerCatalogIngest,
  PAGE_SIZE,
  type CatalogIngestOutcome,
  type CatalogState,
  type CatalogStats,
  type VariantSummary,
} from "../catalogApi.js";
import { useLoadMore } from "../useLoadMore.js";

const STATE_LABELS: Record<VariantSummary["state"], string> = {
  sellable: "Skladom",
  out_of_stock: "Vypredané",
  discontinued: "Predaj skončil",
};

// Rovnaké dve role, ktoré server vyžaduje pre `POST /api/catalog/ingest`
// (`requireRole("admin", "manazer")` v `catalog-routes.ts`) — server ostáva
// skutočnou bránou, toto len skrýva tlačidlo pre role, ktoré by aj tak dostali 403.
const IMPORT_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

interface Notice {
  readonly kind: "info" | "warning";
  readonly text: string;
}

function SnapshotLine({ stats }: { readonly stats: CatalogStats }): JSX.Element {
  const snapshot = stats.lastSnapshot;
  if (snapshot === null) {
    return <p data-testid="snapshot">Katalóg zatiaľ nebol importovaný.</p>;
  }

  const fetchedAtLabel = formatSkDateTime(snapshot.fetchedAt);
  const anomaliesLabel = snapshot.issueCount === null ? "—" : String(snapshot.issueCount);
  const zdrojAAnomalie = `zdroj: ${snapshot.sourceLabel}, anomálií: ${anomaliesLabel}`;

  if (snapshot.verdict === "rejected") {
    // Samostatný, nezameniteľný alert — odmietnutý import nezapíše žiadne riadky,
    // takže čísla nižšie (v `data-testid="counts"`) sú z PREDCHÁDZAJÚCEHO importu,
    // nie z tohto pokusu. To musí byť z tejto vety jasné, inak stránka ticho
    // klame, že je všetko v poriadku.
    return (
      <p data-testid="rejection-alert" role="alert">
        Posledný import bol <strong>zamietnutý</strong> ({fetchedAtLabel}) — dôvod:{" "}
        {snapshot.rejectionReason}. Čísla nižšie pochádzajú z predchádzajúceho prijatého importu.
        ({zdrojAAnomalie})
      </p>
    );
  }

  return (
    <p data-testid="snapshot">
      Posledný import: <strong>prijatý</strong> ({fetchedAtLabel}) — {snapshot.rowCount} riadkov,{" "}
      {snapshot.columnCount} stĺpcov ({zdrojAAnomalie})
    </p>
  );
}

function describeIngestOutcome(result: CatalogIngestOutcome): Notice {
  switch (result.status) {
    case "accepted":
      return {
        kind: "info",
        text: `Import bol úspešný — export obsahoval ${String(result.variantCount)} variantov, ${String(result.productCount)} produktov, ${String(result.missingCount)} novo chýbajúcich, ${String(result.issueCount)} anomálií.`,
      };
    case "rejected":
      return { kind: "warning", text: `Import bol zamietnutý — dôvod: ${result.reason}` };
    case "duplicate":
      return {
        kind: "info",
        text: "Export sa od posledného importu nezmenil — katalóg zostáva nezmenený.",
      };
    case "busy":
      return {
        kind: "warning",
        text: "Import už prebieha na pozadí — počkajte, kým sa dokončí, a skúste to znova.",
      };
  }
}

export function CatalogPage({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [statsError, setStatsError] = useState("");
  const [items, setItems] = useState<readonly VariantSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [searchLoaded, setSearchLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<CatalogState>("all");
  const [searchError, setSearchError] = useState("");
  const [importOutcome, setImportOutcome] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  // Len najnovšia požiadavka smie zapísať výsledok — širšie hľadanie je
  // pomalšie (neindexovaný ILIKE nad celým katalógom), takže staršia, ale
  // širšia odpoveď môže dorásť neskôr než novšia, užšia. Bez tohto poradia
  // dokončenia by sa vykreslil zastaraný výsledok nad novým textom hľadania.
  const searchSeq = useRef(0);

  // issue 254 (súrodenec issue 251's queryRef/stateRef nález, `.claude/
  // rules/frontend-design.md`): `runIngest`u's `.then()` (nižšie) volá
  // `search(query, state)` PRIAMO z uzáveru tejto konkrétnej vykresľovacej
  // inštancie zafixovanej na `onClick`u v momente kliknutia na "Stiahnuť a
  // naimportovať export". Import reálne trvá sekundy až desiatky sekúnd —
  // ak manažér medzitým zmení filter/dopyt a spustí VLASTNÉ vyhľadanie,
  // dokončený import by (bez tohto refu) neskôr TICHO prepísal jeho výsledok
  // STARÝM filtrom — rovnaký mechanizmus ako `PairingSection.tsx`'s
  // `refetch()`/`SupplierLinksSection.tsx`'s `refetch()` (issue 251). Ref sa
  // syncuje PRIAMO V TELE komponentu (počas renderu), NIE cez `useEffect`
  // (rovnaký dôvod ako tam — mikrotaska `.then()` by mohla prečítať ref v
  // okne PRED tým, než by neskôr naplánovaný efekt stihol ref aktualizovať).
  const queryRef = useRef(query);
  queryRef.current = query;
  const stateRef = useRef(state);
  stateRef.current = state;

  // issue 255 (súrodenec issue 251's finding 3 — tento súbor je HIDDEN_TABS
  // komponent, `nav.ts`, odmountuje sa pri prepnutí záložky): rovnaký vzor
  // ako `SupplierLinksSection.tsx`'s `mountedRef`, vrátane StrictMode pasce
  // (`true` musí byť nastavené AJ v efekte, nielen v `useRef(true)`).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadStats = useCallback(() => {
    fetchCatalogStats()
      .then((s) => {
        if (!mountedRef.current) return;
        setStats(s);
        setStatsLoaded(true);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        setStatsLoaded(true);
        if (err instanceof CatalogUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setStatsError("Prehľad katalógu sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  // issue 337: zdieľaný "Načítať ďalšie" mechanizmus (`useLoadMore.ts`) —
  // `reset()` sa volá na ZAČIATKU KAŽDÉHO nového vyhľadávania (nižšie), aby
  // sa zahodila prípadná ešte nedoručená odpoveď na "load more" patriaca
  // STARÉMU dopytu/filtru.
  const loadMoreState = useLoadMore<VariantSummary>({
    mountedRef,
    onAppend: (newItems, newTotal) => {
      setItems((prev) => [...prev, ...newItems]);
      setTotal(newTotal);
    },
    onError: () => {
      setSearchError("Načítanie ďalších položiek zlyhalo.");
    },
  });

  // requesting-code-review finding (issue 337): the "Load more" button MUST
  // fetch the next page of the filter that actually produced the CURRENT
  // `items`/`total` — NOT whatever `query`/`state` currently hold, which
  // track every keystroke/select-change independent of whether `search()`
  // has actually run for them. Without this, typing a new (unsubmitted)
  // query after a search renders, then clicking "Load more", silently
  // fetches page 2 of the NEW query while `total` still reflects the OLD
  // one — set synchronously inside `search()` itself (same "sync in the
  // function that owns the value, not via useEffect" discipline as
  // `queryRef`/`stateRef` above, since `search()` already receives the
  // exact q/s that will produce the results these refs must describe).
  const searchedQueryRef = useRef(query);
  const searchedStateRef = useRef(state);

  const search = useCallback(
    (q: string, s: CatalogState) => {
      const seq = (searchSeq.current += 1);
      setSearchError("");
      searchedQueryRef.current = q;
      searchedStateRef.current = s;
      loadMoreState.reset();
      searchCatalogVariants({ q, state: s, page: 1 })
        .then((result) => {
          if (!mountedRef.current) return; // odmountované skôr, než odpoveď doletela
          if (seq !== searchSeq.current) return; // medzitým prišla novšia požiadavka
          setItems(result.items);
          setTotal(result.total);
          setSearchLoaded(true);
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return;
          if (seq !== searchSeq.current) return;
          setSearchLoaded(true);
          if (err instanceof CatalogUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setItems([]);
          setTotal(0);
          setSearchError("Vyhľadávanie zlyhalo — server neodpovedal.");
        });
    },
    [onSessionExpired],
  );

  useEffect(() => {
    loadStats();
    search("", "all");
  }, [loadStats, search]);

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    search(query, state);
  }

  function runIngest(): void {
    setBusy(true);
    setImportOutcome(null);
    triggerCatalogIngest()
      .then((result) => {
        setImportOutcome(describeIngestOutcome(result));
        loadStats();
        search(queryRef.current, stateRef.current);
      })
      .catch((err: unknown) => {
        if (err instanceof CatalogUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setImportOutcome({
          kind: "warning",
          text: err instanceof Error ? err.message : "Import sa nepodarilo spustiť.",
        });
        // Aj na chybovej ceste — predtým stránka po zlyhanom importe zostala
        // ukazovať PREDCHÁDZAJÚCI prijatý snapshot, hoci v databáze medzitým
        // pribudol nový dôkazový (rejected) záznam (review final-wave-a,
        // položka 7).
        loadStats();
      })
      .finally(() => {
        setBusy(false);
      });
  }

  const canImport = IMPORT_ROLES.has(role);
  const showingAll = total === 0 || items.length >= total;

  return (
    <section>
      <h2>Katalóg</h2>
      {!statsLoaded ? <p>Načítavam prehľad…</p> : stats !== null && <SnapshotLine stats={stats} />}
      {statsError !== "" && <p role="alert">{statsError}</p>}
      {stats !== null && (
        <p data-testid="counts">
          Variantov v katalógu (vrátane chýbajúcich): {stats.variantCount} · produktov:{" "}
          {stats.productCount} · skladom: {stats.sellable} · vypredaných: {stats.outOfStock} ·
          ukončených: {stats.discontinued} · chýbajúcich: {stats.missing}
        </p>
      )}

      {canImport && (
        <button type="button" onClick={runIngest} disabled={busy}>
          {busy ? "Importujem…" : "Stiahnuť a naimportovať export"}
        </button>
      )}
      {importOutcome !== null && (
        <p role={importOutcome.kind === "warning" ? "alert" : "status"} data-testid="import-outcome">
          {importOutcome.text}
        </p>
      )}

      <form onSubmit={submit}>
        <label htmlFor="catalog-q">Kód alebo názov</label>
        <input
          id="catalog-q"
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <label htmlFor="catalog-state">Stav</label>
        <select
          id="catalog-state"
          value={state}
          onChange={(e) => {
            setState(e.target.value as CatalogState);
          }}
        >
          <option value="all">Všetky</option>
          <option value="sellable">Skladom</option>
          <option value="out_of_stock">Vypredané</option>
          <option value="discontinued">Predaj skončil</option>
          <option value="missing">Chýbajúce</option>
        </select>
        <button type="submit">Hľadať</button>
      </form>

      {searchError !== "" && <p role="alert">{searchError}</p>}
      <p data-testid="total">
        {showingAll
          ? `Nájdených: ${String(total)}`
          : `Nájdených: ${String(total)} (zobrazených prvých ${String(items.length)})`}
      </p>

      {searchLoaded && total === 0 ? (
        <p data-testid="empty-results">Hľadaniu nezodpovedá žiadny variant.</p>
      ) : (
        <div className="fs-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Kód</th>
                <th>Názov</th>
                <th>Veľkosť</th>
                <th>Stav</th>
                <th>Sklad</th>
                <th>Cena</th>
                <th>Dostupnosť podľa Shoptetu</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.code} data-testid={`variant-${item.code}`}>
                  <td>{item.code}</td>
                  <td>{item.name}</td>
                  <td>{item.sizeLabel ?? "—"}</td>
                  <td>
                    {STATE_LABELS[item.state]}
                    {item.missingSince !== null && (
                      <>
                        {" "}
                        <strong data-testid={`missing-${item.code}`}>
                          (chýba od {formatSkDate(item.missingSince)})
                        </strong>
                      </>
                    )}
                  </td>
                  <td>{item.stock}</td>
                  <td>{item.price === null ? "—" : `${item.price} ${item.currency ?? ""}`}</td>
                  <td>{item.availabilityText === "" ? "—" : item.availabilityText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {items.length < total && (
        <button
          type="button"
          data-testid="load-more"
          disabled={loadMoreState.loadingMore}
          onClick={() => {
            loadMoreState.loadMore((page) =>
              searchCatalogVariants({ q: searchedQueryRef.current, state: searchedStateRef.current, page }),
            );
          }}
        >
          {loadMoreState.loadingMore
            ? "Načítavam…"
            : `Načítať ďalšie (${String(Math.min(PAGE_SIZE, total - items.length))})`}
        </button>
      )}
    </section>
  );
}
