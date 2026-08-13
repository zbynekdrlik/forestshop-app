import { useCallback, useRef, useState, type SyntheticEvent, type JSX } from "react";
import type { Me } from "../api.js";
import { fetchPairingReviewItem, PairingReviewUnauthorizedError, type PairingReviewItem } from "../pairingReviewApi.js";
import { globalSearch, SearchUnauthorizedError, type ProductSearchHit } from "../searchApi.js";
import { PairingReviewCard } from "./PairingReviewCard.js";

// issue 399 — "Hľadať / opraviť": pod-záložka obrazovky "Eshop → Párovanie",
// NIE duplikát "Eshop → Vyhľadať" (#240) — vyhľadávacie pole ZNOVUPOUŽÍVA TEN
// ISTÝ `GET /api/search` (kód/názov/dodávateľ, presne zadanie), ale
// výsledok otvára `PairingReviewCard.tsx` NEZMENENÚ cez NOVÝ jednoproduktový
// endpoint (`fetchPairingReviewItem`, `getPairingReviewItem` na serveri) —
// funguje pre AKÝKOĽVEK produkt, nezávisle od `listPairingReview`'s
// populácie (design komentár na tickete, sekcia "Prístup 1"). Zdieľanú kartu
// dostáva ZADARMO: 📦/🚫 terminálne tlačidlá, "✗ Zmeniť / iný link" pre už
// rozhodnuté produkty, aj nové "✂ Rozdeliť na veľkosti" — nulová duplicita UI.
//
// `GET /api/search` vracia PER-VARIANT riadky — dedup podľa `productKey`
// (prvý výskyt vyhráva), keďže Párovanie je produktovo-úrovňová obrazovka.

const STATE_LABELS: Readonly<Record<ProductSearchHit["state"], string>> = {
  sellable: "🟢 Skladom",
  out_of_stock: "📦 Nie je skladom",
  discontinued: "🚫 Už sa nebude predávať",
};

function dedupeByProductKey(hits: readonly ProductSearchHit[]): ProductSearchHit[] {
  const seen = new Set<string>();
  const out: ProductSearchHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.productKey)) continue;
    seen.add(hit.productKey);
    out.push(hit);
  }
  return out;
}

export function PairingSearchFixTab({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly ProductSearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchSeq = useRef(0);

  const [selectedProductKey, setSelectedProductKey] = useState<string | null>(null);
  const [item, setItem] = useState<PairingReviewItem | null>(null);
  const [itemLoaded, setItemLoaded] = useState(false);
  const [itemError, setItemError] = useState("");
  const itemSeq = useRef(0);

  const search = useCallback(
    (q: string) => {
      const seq = (searchSeq.current += 1);
      setSearchError("");
      globalSearch(q)
        .then((r) => {
          if (seq !== searchSeq.current) return;
          setHits(dedupeByProductKey(r.products));
          setSearched(true);
        })
        .catch((err: unknown) => {
          if (seq !== searchSeq.current) return;
          setSearched(true);
          if (err instanceof SearchUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setHits([]);
          setSearchError("Vyhľadávanie zlyhalo — server neodpovedal.");
        });
    },
    [onSessionExpired],
  );

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    search(query);
  }

  const openItem = useCallback(
    (productKey: string) => {
      setSelectedProductKey(productKey);
      setItem(null);
      setItemLoaded(false);
      setItemError("");
      const seq = (itemSeq.current += 1);
      fetchPairingReviewItem(productKey)
        .then((result) => {
          if (seq !== itemSeq.current) return;
          setItem(result);
          setItemLoaded(true);
        })
        .catch((err: unknown) => {
          if (seq !== itemSeq.current) return;
          setItemLoaded(true);
          if (err instanceof PairingReviewUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setItemError("Produkt sa nepodarilo načítať.");
        });
    },
    [onSessionExpired],
  );

  const backToResults = useCallback(() => {
    setSelectedProductKey(null);
    setItem(null);
  }, []);

  // Po rozhodnutí/uložení na karte znova načítaj TEN ISTÝ produkt (rovnaký
  // zdroj pravdy ako `PairingReviewSection.tsx`'s `onDecided`, žiadna
  // duplicitná klientská logika) — karta ostane otvorená, len sa obnoví.
  const onDecided = useCallback(() => {
    if (selectedProductKey !== null) openItem(selectedProductKey);
  }, [selectedProductKey, openItem]);

  if (selectedProductKey !== null) {
    return (
      <div data-testid="pairing-search-fix-detail">
        <button type="button" className="btn ghost sm" onClick={backToResults} data-testid="pairing-search-fix-back">
          ← Späť na výsledky
        </button>
        {itemError !== "" && <p role="alert">{itemError}</p>}
        {!itemLoaded && itemError === "" && <p>Načítavam produkt…</p>}
        {itemLoaded && item === null && (
          <p data-testid="pairing-search-fix-notfound">Produkt sa nenašiel.</p>
        )}
        {item !== null && <PairingReviewCard item={item} role={role} onDecided={onDecided} onSessionExpired={onSessionExpired} />}
      </div>
    );
  }

  return (
    <div data-testid="pairing-search-fix">
      <p>
        Nájdi ktorýkoľvek produkt (kód, názov alebo dodávateľ) a nastav/oprav mu odkaz na dodávateľa — funguje aj
        pre produkty, čo už nejaký odkaz majú.
      </p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="pairing-search-fix-q">Kód, názov alebo dodávateľ</label>
          <input
            id="pairing-search-fix-q"
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
        </div>
        <div className="form-actions">
          <button type="submit" className="btn good">
            Hľadať
          </button>
        </div>
      </form>

      {searchError !== "" && <p role="alert">{searchError}</p>}
      {searched && hits.length === 0 && <p data-testid="pairing-search-fix-empty">Nič sa nenašlo.</p>}

      {hits.length > 0 && (
        <div className="fs-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Kód</th>
                <th>Názov</th>
                <th>Dodávateľ</th>
                <th>Stav</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {hits.map((h) => (
                <tr key={h.productKey} data-testid={`pairing-search-fix-row-${h.productKey}`}>
                  <td>{h.variantCode}</td>
                  <td>{h.productName}</td>
                  <td>{h.supplier ?? "(bez dodávateľa)"}</td>
                  <td>{STATE_LABELS[h.state]}</td>
                  <td>
                    <button
                      type="button"
                      className="btn sm ghost"
                      data-testid={`pairing-search-fix-open-${h.productKey}`}
                      onClick={() => {
                        openItem(h.productKey);
                      }}
                    >
                      Otvoriť
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
