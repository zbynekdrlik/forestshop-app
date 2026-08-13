import { useCallback, useRef, useState, type JSX } from "react";
import { globalSearch, SearchUnauthorizedError, type ProductSearchHit } from "../searchApi.js";

// issue 410: pripínanie produktu na zápis "Objednávky predajňa" — vyhľadáva
// PRESNE tou istou logikou/cestou ako "Eshop → Vyhľadať" (`SearchSection.tsx`
// volá TÚ ISTÚ `globalSearch()`, len tu sa použije jej `.products` polovica —
// `.claude/rules/search.md`). Žiadna nová backendová vyhľadávacia trasa.
export function FloorNoteProductSearch({
  alreadyAttached,
  attaching,
  onAttach,
  onSessionExpired,
}: {
  readonly alreadyAttached: ReadonlySet<string>;
  readonly attaching: boolean;
  readonly onAttach: (hit: ProductSearchHit) => void;
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<readonly ProductSearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  // Len najnovšia požiadavka smie zapísať výsledok — rovnaký vzor ako
  // `SearchSection.tsx`'s `searchSeq`.
  const searchSeq = useRef(0);

  const search = useCallback(() => {
    const q = query.trim();
    if (q === "") return;
    const seq = (searchSeq.current += 1);
    setError("");
    globalSearch(q)
      .then((r) => {
        if (seq !== searchSeq.current) return;
        setResult(r.products);
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
        setError("Vyhľadávanie zlyhalo — server neodpovedal.");
      });
  }, [query, onSessionExpired]);

  return (
    <div className="floor-note-product-search" data-testid="floor-note-product-search">
      <div className="floor-note-product-search-row">
        <input
          type="search"
          aria-label="Hľadať produkt na pripnutie"
          placeholder="Kód, názov alebo dodávateľ…"
          value={query}
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              search();
            }
          }}
          data-testid="floor-note-product-search-input"
        />
        <button type="button" className="btn sm good" disabled={query.trim() === ""} onClick={search} data-testid="floor-note-product-search-submit">
          Hľadať
        </button>
      </div>

      {error !== "" && <p role="alert">{error}</p>}
      {searched && result.length === 0 && <p data-testid="floor-note-product-search-empty">Produktu nezodpovedá nič.</p>}

      {result.length > 0 && (
        <ul className="floor-note-product-search-results" data-testid="floor-note-product-search-results">
          {result.map((hit) => {
            const pinned = alreadyAttached.has(hit.variantCode);
            return (
              <li key={hit.variantCode} className="floor-note-product-search-hit">
                <span>
                  {hit.variantCode} — {hit.productName}
                  {hit.sizeLabel !== null && ` (${hit.sizeLabel})`}
                </span>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={pinned || attaching}
                  onClick={() => {
                    onAttach(hit);
                  }}
                  data-testid={`floor-note-product-pin-${hit.variantCode}`}
                >
                  {pinned ? "Pripnuté" : "📌 Pripnúť"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
