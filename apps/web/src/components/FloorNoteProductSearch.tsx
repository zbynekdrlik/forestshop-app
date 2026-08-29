import { useCallback, useState, type JSX } from "react";
import { useStaleResponseGuard } from "../useStaleResponseGuard.js";
import { globalSearch, SearchUnauthorizedError, type ProductSearchHit } from "../searchApi.js";

// issue 410: pripínanie produktu na zápis "Objednávky predajne" — vyhľadáva
// PRESNE tou istou logikou/cestou ako "Eshop → Vyhľadať" (`SearchSection.tsx`
// volá TÚ ISTÚ `globalSearch()`, len tu sa použije jej `.products` polovica —
// `.claude/rules/search.md`). Žiadna nová backendová vyhľadávacia trasa.
// issue 453: pri každom výsledku je malý vstup na POČET KUSOV (default 1),
// odošle sa spolu s pripnutím (`onAttach(hit, quantity)`).
const MAX_QUANTITY = 1_000_000;
function clampQuantity(raw: string): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(MAX_QUANTITY, Math.max(1, n)) : 1;
}

export function FloorNoteProductSearch({
  alreadyAttached,
  attaching,
  onAttach,
  onSessionExpired,
}: {
  readonly alreadyAttached: ReadonlySet<string>;
  readonly attaching: boolean;
  readonly onAttach: (hit: ProductSearchHit, quantity: number) => void;
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<readonly ProductSearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  // Počet kusov na pripnutie, per variantCode — držaný ako reťazec (vstup ho
  // môže mať dočasne prázdny), pri pripnutí sa `clampQuantity`-uje na ≥ 1.
  const [quantities, setQuantities] = useState<Record<string, string>>({});

  // Len najnovšia požiadavka smie zapísať výsledok (zdieľaný `useStaleResponseGuard`, issue 523).
  const guard = useStaleResponseGuard();

  const search = useCallback(() => {
    const q = query.trim();
    if (q === "") return;
    const seq = guard.begin();
    setError("");
    globalSearch(q)
      .then((r) => {
        if (!guard.isLatest(seq)) return;
        setResult(r.products);
        setSearched(true);
      })
      .catch((err: unknown) => {
        if (!guard.isLatest(seq)) return;
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
            const qty = quantities[hit.variantCode] ?? "1";
            return (
              <li key={hit.variantCode} className="floor-note-product-search-hit">
                <span>
                  {hit.variantCode} — {hit.productName}
                  {hit.sizeLabel !== null && ` (${hit.sizeLabel})`}
                </span>
                <span className="floor-note-product-search-actions">
                  <input
                    type="number"
                    min={1}
                    max={MAX_QUANTITY}
                    className="floor-note-product-qty-input"
                    aria-label={`Počet kusov — ${hit.productName}`}
                    value={qty}
                    disabled={pinned || attaching}
                    onChange={(e) => {
                      const v = e.target.value;
                      setQuantities((prev) => ({ ...prev, [hit.variantCode]: v }));
                    }}
                    data-testid={`floor-note-product-search-qty-${hit.variantCode}`}
                  />
                  <span className="floor-note-product-qty-unit">ks</span>
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={pinned || attaching}
                    onClick={() => {
                      onAttach(hit, clampQuantity(qty));
                    }}
                    data-testid={`floor-note-product-pin-${hit.variantCode}`}
                  >
                    {pinned ? "Pripnuté" : "📌 Pripnúť"}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
