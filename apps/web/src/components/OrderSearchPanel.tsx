import { useCallback, useRef, useState, type SyntheticEvent, type JSX } from "react";
import { globalSearch, SearchUnauthorizedError, type OrderSearchHit } from "../searchApi.js";

// issue 289: "Eshop → Vyhľadať" — druhé, NEZÁVISLÉ pole "Objednávka" (vlastný
// dopyt/výsledok/stav, nič zdieľané s `SearchSection.tsx`'s "Produkt" pole
// okrem tej istej `GET /api/search` cesty, ktorá vždy vracia OBOJE — tento
// panel si z odpovede vezme len `.orders`). Vydelené do vlastného súboru,
// nie len kvôli `max-lines`: `SearchSection.tsx` vie namontovať tento panel
// AJ počas zobrazenia detailu produktu (mimo jej `if (selectedProductKey…)`
// vetvy), takže hľadanie objednávky prežije prechod do/z detailu produktu
// bez straty dopytu/výsledku — presne to isté správanie, aké malo pôvodné
// jedno spoločné pole (issue 240), keď `result` žil v tom istom komponente,
// ktorý sa nikdy neodmountoval.
export function OrderSearchPanel({
  onSessionExpired,
}: {
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<readonly OrderSearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState("");

  // Len najnovšia požiadavka smie zapísať výsledok — rovnaký vzor ako
  // `SearchSection.tsx`'s `searchSeq`.
  const searchSeq = useRef(0);

  const search = useCallback(
    (q: string) => {
      const seq = (searchSeq.current += 1);
      setSearchError("");
      globalSearch(q)
        .then((r) => {
          if (seq !== searchSeq.current) return;
          setResult(r.orders);
          setSearched(true);
        })
        .catch((err: unknown) => {
          if (seq !== searchSeq.current) return;
          setSearched(true);
          if (err instanceof SearchUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setResult([]);
          setSearchError("Vyhľadávanie zlyhalo — server neodpovedal.");
        });
    },
    [onSessionExpired],
  );

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    search(query);
  }

  return (
    <div data-testid="search-order-panel">
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="search-order-q">Objednávka</label>
          <input
            id="search-order-q"
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
        </div>
        <div className="form-actions">
          <button type="submit" className="btn good">
            Hľadať objednávku
          </button>
        </div>
      </form>

      {searchError !== "" && <p role="alert">{searchError}</p>}

      {searched && result.length === 0 && <p data-testid="search-order-empty">Objednávke nezodpovedá nič.</p>}

      {result.length > 0 && (
        <div data-testid="search-orders">
          <h3>Objednávky</h3>
          <div className="fs-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Číslo</th>
                  <th>Zákazník</th>
                  <th>Stav</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {result.map((o) => (
                  <tr key={o.orderId} data-testid={`search-order-${o.externalOrderId}`}>
                    <td>{o.externalOrderId}</td>
                    <td>
                      {o.customerName}
                      {o.email !== null && ` (${o.email})`}
                    </td>
                    <td>{o.statusName}</td>
                    <td>
                      <a
                        href={o.adminUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        data-testid={`search-order-admin-link-${o.externalOrderId}`}
                      >
                        Otvoriť v Shoptete
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
