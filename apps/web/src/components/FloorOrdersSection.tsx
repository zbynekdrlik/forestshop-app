import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { formatSkDate } from "../formatDate.js";
import { fetchFloorOrders, FloorOrdersUnauthorizedError, PAGE_SIZE, type FloorOrderRow } from "../floorOrdersApi.js";
import { useLoadMore } from "../useLoadMore.js";

// issue 345: "Eshop → Objednávky predajňa" — READ-ONLY zoznam objednávok,
// ktoré nevznikli v e-shope, ale na kamennej predajni (`shipping_carrier_
// name` obsahuje "Osobný odber", `apps/api/src/modules/orders/floor-orders-
// queries.ts`). Vlastná malá tabuľka namiesto zdieľanej `OrderFlagTable.tsx`
// — tá nesie stĺpec "Poznámka" a štítok "nevybavené", ktoré zadanie tiketu
// nežiada (návrhový komentár na tickete). `useLoadMore` (#337) — rovnaký
// vzor ako `RestockLinkSuggestionsSection.tsx`.
export function FloorOrdersSection({ onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  const [items, setItems] = useState<readonly FloorOrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  // Rovnaký dôvod ako `RestockLinkSuggestionsSection.tsx`/`SupplierLinksSection.tsx`
  // (issue 251, StrictMode double-mount past — `.claude/rules/frontend-design.md`).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadMoreState = useLoadMore<FloorOrderRow>({
    mountedRef,
    onAppend: (newItems, newTotal) => {
      setItems((prev) => [...prev, ...newItems]);
      setTotal(newTotal);
    },
    onError: () => {
      setError("Načítanie ďalších objednávok zlyhalo.");
    },
  });

  // "Latest generation" vzor (review finding, issue 345 — rovnaký dôvod ako
  // `SupplierLinksSection.tsx`/`RestockLinkSuggestionsSection.tsx`'s
  // `searchSeq`): bez neho by neskoro doručená (napr. StrictMode double-
  // mount) odpoveď TEJTO funkcie mohla prepísať `items` SPÄŤ na prvú stranu
  // PO tom, čo už používateľ klikol "Načítať ďalšie" — `useLoadMore`'s
  // interný `pageRef` by pritom ostal na strane 2, takže ďalší klik by
  // preskočil rovno na stranu 3 a stratil riadky strany 2.
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = (loadSeq.current += 1);
    setError("");
    loadMoreState.reset();
    fetchFloorOrders({ page: 1 })
      .then((result) => {
        if (!mountedRef.current || seq !== loadSeq.current) return;
        setItems(result.items);
        setTotal(result.total);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || seq !== loadSeq.current) return;
        setLoaded(true);
        if (err instanceof FloorOrdersUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setItems([]);
        setTotal(0);
        setError("Zoznam objednávok predajne sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(() => {
    load();
  }, [load]);

  const showingAll = total === 0 || items.length >= total;

  return (
    <section data-testid="floor-orders-section">
      <p>
        Objednávky, ktoré Shoptet eviduje s dopravou „Osobný odber“ — teda vznikli priamo na predajni,
        nie v e-shope.
      </p>

      {error !== "" && <p role="alert">{error}</p>}

      {!loaded ? (
        <p>Načítavam…</p>
      ) : total === 0 ? (
        // review finding (issue 345): keď POČIATOČNÉ načítanie zlyhá, `total`
        // je tiež `0` — bez `error === ""` by táto obrazovka klamlivo tvrdila
        // "žiadna objednávka" popri chybovej hláške vyššie. Chyba pri "Načítať
        // ďalšie" sem nikdy nespadne (`total`/`items` sa vtedy nemenia, viď
        // `useLoadMore`'s `onError`), takže tabuľka nižšie ostáva viditeľná aj
        // pri takej chybe — rovnaké správanie ako `RestockLinkSuggestionsSection.tsx`.
        error === "" && <p data-testid="floor-orders-empty">Momentálne žiadna objednávka z predajne nie je evidovaná.</p>
      ) : (
        <>
          <p data-testid="floor-orders-total">
            {showingAll
              ? `Nájdených: ${String(total)}`
              : `Nájdených: ${String(total)} (zobrazených prvých ${String(items.length)})`}
          </p>
          <div className="fs-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Číslo</th>
                  <th>Dátum</th>
                  <th>Zákazník</th>
                  <th>Stav</th>
                  <th>Suma</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} data-testid={`floor-order-row-${row.externalOrderId}`}>
                    <td>{row.externalOrderId}</td>
                    <td>{formatSkDate(row.placedAt)}</td>
                    <td>{row.customerName}</td>
                    <td>{row.statusName}</td>
                    <td>{row.totalPriceWithVat === null ? "—" : `${row.totalPriceWithVat} €`}</td>
                    <td>
                      <a
                        href={row.adminUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        data-testid={`floor-order-admin-link-${row.externalOrderId}`}
                      >
                        Otvoriť v Shoptete
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {items.length < total && (
        <button
          type="button"
          data-testid="load-more"
          disabled={loadMoreState.loadingMore}
          onClick={() => {
            loadMoreState.loadMore((page) => fetchFloorOrders({ page }));
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
