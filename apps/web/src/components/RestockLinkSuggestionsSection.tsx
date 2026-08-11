import { useCallback, useContext, useEffect, useRef, useState, type SyntheticEvent, type JSX } from "react";
import type { Me } from "../api.js";
import { validateSupplierLinkUrl } from "../ordersApi.js";
import { RestockLinksBadgeRefreshContext } from "../restockLinksBadgeContext.js";
import { saveProductLink, SupplierLinksUnauthorizedError } from "../supplierLinksApi.js";
import {
  RestockLinksUnauthorizedError,
  searchRestockLinkSuggestions,
  PAGE_SIZE,
  type RestockLinkMissingItem,
} from "../restockLinksApi.js";
import { useLoadMore } from "../useLoadMore.js";

// issue 311: "Vypredané → Skladom: návrhy odkazov" — priamy náprotivok
// `SupplierLinksSection.tsx` (#239), len ZÚŽENÝ na populáciu vypredaných
// produktov (rovnaká ako `restock/queries.ts`'s kandidáti, `.claude/rules/
// restock-links.md`) a s NAVRHOVANÝM kandidátom (odvodený zo zhody mena +
// dodávateľa s produktmi, čo UŽ linku majú). Zápis potvrdenia ide cez UŽ
// existujúcu `saveProductLink` (#239) — žiadna nová zapisovacia trasa.
// issue 331: klik na kandidáta odteraz UKLADÁ PRIAMO (jeden klik, meno aj
// URL sú na tlačidle vidno PRED kliknutím — stále výslovné ľudské
// potvrdenie NA KONKRÉTNOM návrhu, nikdy automatické priradenie) namiesto
// pôvodného dvojklikového "predvyplň → Uložiť". "✏️ Doplniť" (ručný/opravný
// vstup) ostáva bezo zmeny pre korekciu/vlastnú adresu.
const CAN_EDIT_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

export function RestockLinkSuggestionsSection({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [items, setItems] = useState<readonly RestockLinkMissingItem[]>([]);
  const [total, setTotal] = useState(0);
  const [searchLoaded, setSearchLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [searchError, setSearchError] = useState("");
  const [actionError, setActionError] = useState("");
  const canEdit = CAN_EDIT_ROLES.has(role);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // issue 331: odznak v ľavom menu (`App.tsx`) sa musí prepočítať po
  // KAŽDOM úspešnom potvrdení (jednoklikovom aj cez ✏️ Doplniť) — inak by
  // číslo v menu zaostávalo za tým, čo obrazovka práve zapísala.
  const restockLinksBadge = useContext(RestockLinksBadgeRefreshContext);

  // Len najnovšia požiadavka smie zapísať výsledok (rovnaký dôvod ako
  // `SupplierLinksSection.tsx`'s `searchSeq`).
  const searchSeq = useRef(0);

  // Rovnaký dôvod ako `SupplierLinksSection.tsx` (issue 251, StrictMode).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // issue 337: zdieľaný "Načítať ďalšie" mechanizmus, `useLoadMore.ts`.
  const loadMoreState = useLoadMore<RestockLinkMissingItem>({
    mountedRef,
    onAppend: (newItems, newTotal) => {
      setItems((prev) => [...prev, ...newItems]);
      setTotal(newTotal);
    },
    onError: () => {
      setSearchError("Načítanie ďalších položiek zlyhalo.");
    },
  });

  const search = useCallback((q: string) => {
    const seq = (searchSeq.current += 1);
    setSearchError("");
    loadMoreState.reset();
    searchRestockLinkSuggestions({ q, page: 1 })
      .then((result) => {
        if (!mountedRef.current) return;
        if (seq !== searchSeq.current) return;
        setItems(result.items);
        setTotal(result.total);
        setSearchLoaded(true);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        if (seq !== searchSeq.current) return;
        setSearchLoaded(true);
        if (err instanceof RestockLinksUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setItems([]);
        setTotal(0);
        setSearchError("Zoznam sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(() => {
    search("");
  }, [search]);

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    search(query);
  }

  // "Latest ref" vzor (rovnaký dôvod ako `SupplierLinksSection.tsx`, issue
  // 251) — `refetch` volaný zo `save()`'s `.then()` (mikrotaska) musí čítať
  // AKTUÁLNY dopyt, nie ten zafixovaný v uzávere v momente kliknutia.
  const queryRef = useRef(query);
  queryRef.current = query;
  const refetch = useCallback(() => {
    search(queryRef.current);
  }, [search]);

  const editingKeyRef = useRef(editingKey);
  editingKeyRef.current = editingKey;

  const startEdit = useCallback((item: RestockLinkMissingItem) => {
    setEditingKey(item.productKey);
    // Predvyplní PRVÝM (najlepšie skórovaným) návrhom, keď existuje — človek
    // ho môže rovno uložiť, alebo prepísať vlastnou adresou. Nikdy sa
    // neuloží samo — toto je len predvyplnenie vstupu.
    setUrlDraft(item.candidates[0]?.url ?? "");
    setActionError("");
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingKey(null);
    setActionError("");
  }, []);

  const save = useCallback(
    (productKey: string) => {
      setActionError("");
      const validationError = validateSupplierLinkUrl(urlDraft);
      if (validationError !== null) {
        setActionError(validationError);
        return;
      }
      setBusyKey(productKey);
      saveProductLink(productKey, urlDraft.trim())
        .then(() => {
          if (editingKeyRef.current === productKey) setEditingKey(null);
          refetch();
          restockLinksBadge.refresh();
        })
        .catch((err: unknown) => {
          if (err instanceof SupplierLinksUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Uloženie odkazu sa nepodarilo.");
        })
        .finally(() => {
          setBusyKey(null);
        });
    },
    [refetch, onSessionExpired, urlDraft, restockLinksBadge],
  );

  // issue 331: jednoklikové potvrdenie kandidáta — na rozdiel od `save()`
  // vyššie (ktorý ukladá `urlDraft` z otvoreného editora) tento ukladá
  // PRIAMO URL konkrétneho, na tlačidle viditeľne popísaného kandidáta bez
  // otvárania editora. Stále výslovný ľudský klik na KONKRÉTNY návrh —
  // nikdy automatické priradenie bez klik.
  const confirmCandidate = useCallback(
    (productKey: string, url: string) => {
      setActionError("");
      setBusyKey(productKey);
      saveProductLink(productKey, url)
        .then(() => {
          if (editingKeyRef.current === productKey) setEditingKey(null);
          refetch();
          restockLinksBadge.refresh();
        })
        .catch((err: unknown) => {
          if (err instanceof SupplierLinksUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Uloženie odkazu sa nepodarilo.");
        })
        .finally(() => {
          setBusyKey(null);
        });
    },
    [refetch, onSessionExpired, restockLinksBadge],
  );

  // issue 337: rovnaká "zobrazených prvých M" poznámka ako `CatalogPage.tsx`/
  // `PairingSection.tsx`/`SupplierLinksSection.tsx` — predtým chýbala, holé
  // "Nájdených: N" neukazovalo, že za prvou stranou môže byť ešte viac.
  const showingAll = total === 0 || items.length >= total;

  return (
    <section data-testid="restock-links-section">
      <p>
        Vypredané produkty, ktoré nemajú VÔBEC žiadny odkaz na dodávateľa — automatika „Vypredané →
        Skladom“ ich preto nikdy neposúdi. Appka podľa názvu a dodávateľa navrhne najpodobnejší
        produkt, čo linku už má — klik na „✅ Potvrdiť“ pri návrhu ho rovno uloží (meno aj adresa sú
        na tlačidle vidno pred kliknutím). Vlastnú alebo opravenú adresu vlož cez „✏️ Doplniť“.
      </p>

      <form onSubmit={submit}>
        <label htmlFor="restock-links-q">Hľadať produkt (kód alebo názov)</label>
        <input
          id="restock-links-q"
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <button type="submit">Zobraziť</button>
      </form>

      {searchError !== "" && <p role="alert">{searchError}</p>}
      {actionError !== "" && <p role="alert">{actionError}</p>}
      <p data-testid="restock-links-total">
        {showingAll
          ? `Nájdených: ${String(total)}`
          : `Nájdených: ${String(total)} (zobrazených prvých ${String(items.length)})`}
      </p>

      {searchLoaded && total === 0 ? (
        <p data-testid="restock-links-empty">Žiadny vypredaný produkt bez linky sa nenašiel.</p>
      ) : (
        <div className="fs-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Kód</th>
                <th>Názov</th>
                <th>Dodávateľ</th>
                <th>Návrh</th>
                <th>Odkaz na dodávateľa</th>
                {canEdit && <th>Akcie</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const editing = editingKey === item.productKey;
                const busyHere = busyKey === item.productKey;
                return (
                  <tr key={item.productKey} data-testid={`restock-link-row-${item.productKey}`}>
                    <td>{item.productKey}</td>
                    <td>{item.productName}</td>
                    <td>{item.supplier ?? "(bez dodávateľa)"}</td>
                    <td data-testid={`restock-link-candidates-${item.productKey}`}>
                      {item.candidates.length === 0 ? (
                        <span>—</span>
                      ) : (
                        item.candidates.map((candidate) => (
                          <div key={candidate.productKey}>
                            {canEdit ? (
                              <button
                                type="button"
                                className="btn sm good"
                                data-testid={`restock-link-confirm-${item.productKey}-${candidate.productKey}`}
                                aria-label={`Potvrdiť odkaz — ${candidate.productName} (${candidate.url})`}
                                disabled={busyHere}
                                onClick={() => {
                                  confirmCandidate(item.productKey, candidate.url);
                                }}
                              >
                                ✅ {candidate.productName}: {candidate.url}
                              </button>
                            ) : (
                              <span>
                                💡 {candidate.productName}: {candidate.url}
                              </span>
                            )}
                          </div>
                        ))
                      )}
                    </td>
                    <td>
                      {editing ? (
                        <div className="ord-supplier-link-edit" data-testid={`restock-link-edit-${item.productKey}`}>
                          <input
                            type="url"
                            className="ord-supplier-link-edit-input"
                            data-testid={`restock-link-edit-input-${item.productKey}`}
                            aria-label={`Odkaz na dodávateľa produktu ${item.productName} / ${item.productKey}`}
                            placeholder="https://…"
                            value={urlDraft}
                            disabled={busyHere}
                            autoFocus
                            onChange={(e) => {
                              setUrlDraft(e.target.value);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                save(item.productKey);
                                return;
                              }
                              if (e.key === "Escape") {
                                e.preventDefault();
                                cancelEdit();
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="btn sm good"
                            data-testid={`restock-link-save-${item.productKey}`}
                            aria-label={`Uložiť odkaz na dodávateľa produktu ${item.productName} / ${item.productKey}`}
                            disabled={busyHere || urlDraft.trim() === ""}
                            onClick={() => {
                              save(item.productKey);
                            }}
                          >
                            💾
                          </button>
                          <button
                            type="button"
                            className="btn sm ghost"
                            data-testid={`restock-link-cancel-${item.productKey}`}
                            aria-label="Zrušiť úpravu"
                            disabled={busyHere}
                            onClick={cancelEdit}
                          >
                            ✖
                          </button>
                        </div>
                      ) : (
                        <span data-testid={`restock-link-url-${item.productKey}`}>—</span>
                      )}
                    </td>
                    {canEdit && (
                      <td>
                        {!editing && (
                          <button
                            type="button"
                            className="btn sm ghost"
                            data-testid={`restock-link-edit-toggle-${item.productKey}`}
                            aria-label={`Doplniť odkaz na dodávateľa — ${item.productName} (${item.productKey})`}
                            disabled={busyHere}
                            onClick={() => {
                              startEdit(item);
                            }}
                          >
                            ✏️ Doplniť
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
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
            loadMoreState.loadMore((page) => searchRestockLinkSuggestions({ q: query, page }));
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
