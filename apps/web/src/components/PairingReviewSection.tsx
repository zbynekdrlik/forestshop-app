import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  PAGE_SIZE,
  PAIRING_REVIEW_FILTERS,
  PairingReviewUnauthorizedError,
  searchPairingReview,
  type PairingReviewFilter,
  type PairingReviewItem,
} from "../pairingReviewApi.js";
import { useLoadMore } from "../useLoadMore.js";
import { PairingReviewCard } from "./PairingReviewCard.js";

// issue 387 E5: "Eshop → Párovanie" — čítacia obrazovka (karty + filtre) nad
// tým, čo E3 (gather)/E4 (verify) zozbierali. LEN čítanie, žiadne akcie
// (rozhodnutia prídu v E6). Design komentár na tickete (issue 387 E5):
// "unreviewed" (default filter, aj badge v `App.tsx`) = "produkt z gather
// populácie BEZ efektívnej dodávateľskej linky" — pairing_decision (E6) tu
// ešte neexistuje.
//
// Konvencie appky (`.claude/rules/frontend-design.md`): `useLoadMore` pre
// stránkovanie, "latest ref" vzor pre `.then()`, `mountedRef` StrictMode-
// bezpečný vzor (issue 251 — `mountedRef.current = true` nastavené AJ v tele
// efektu, nielen v `useRef` počiatočnej hodnote). Viditeľná záložka v `NAV`
// (`nav.ts`) — ŽIADEN vlastný `<h1>`/`<h2>`, `App.tsx`/`Topbar` ho vykreslí sám.

const FILTER_LABELS: Readonly<Record<PairingReviewFilter, string>> = {
  unreviewed: "Nezrevidované",
  matched: "Napárované (AI)",
  unmatched: "Nenapárované",
  st1: "🟢 Skladom",
  st2: "📦 Nie skladom",
  st3: "🚫 Nepredáva sa",
  all: "Všetky",
};

const FILTER_STORAGE_KEY = "pairingReviewFilter";
const SCROLL_STORAGE_KEY = "pairingReviewScrollY";

function readStoredFilter(): PairingReviewFilter {
  try {
    const stored = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (stored !== null && (PAIRING_REVIEW_FILTERS as readonly string[]).includes(stored)) return stored as PairingReviewFilter;
  } catch {
    // Prehliadač s vypnutým úložiskom — padni na predvolený filter.
  }
  return "unreviewed";
}

// issue 342 vzor (`DailyTasksSection.tsx`): obrazovka nemá žiadne rolové
// rozlíšenie (E5 je čisto čítanie, bez akcií) — užší typ props než zdieľané
// `SectionProps` je platný podtyp `ComponentType<SectionProps>` (nav.ts),
// keďže `App.tsx` odovzdáva SKUTOČNÝ objekt, nie literál (žiadna "excess
// property" kontrola).
export function PairingReviewSection({ onSessionExpired }: { readonly onSessionExpired: () => void }): JSX.Element {
  const [filter, setFilter] = useState<PairingReviewFilter>(readStoredFilter);
  const [items, setItems] = useState<readonly PairingReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [gatheredTotal, setGatheredTotal] = useState(0);
  const [linkedTotal, setLinkedTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const searchSeq = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadMoreState = useLoadMore<PairingReviewItem>({
    mountedRef,
    onAppend: (newItems, newTotal) => {
      setItems((prev) => [...prev, ...newItems]);
      setTotal(newTotal);
    },
    onError: () => {
      setError("Načítanie ďalších položiek zlyhalo.");
    },
  });

  // issue 337 vzor (`RestockLinkSuggestionsSection.tsx`/`CatalogPage.tsx`):
  // "Načítať ďalšie" musí siahnuť po ĎALŠEJ strane TOHO filtra, čo vyprodukoval
  // AKTUÁLNE zobrazené `items`, nie live hodnotu `filter` (tá sa môže medzitým
  // rozísť, keby užívateľ prepol filter tesne pred kliknutím).
  const loadedFilterRef = useRef(filter);

  const load = useCallback((f: PairingReviewFilter) => {
    const seq = (searchSeq.current += 1);
    setError("");
    loadedFilterRef.current = f;
    loadMoreState.reset();
    searchPairingReview({ filter: f, page: 1 })
      .then((result) => {
        if (!mountedRef.current || seq !== searchSeq.current) return;
        setItems(result.items);
        setTotal(result.total);
        setGatheredTotal(result.gatheredTotal);
        setLinkedTotal(result.linkedTotal);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || seq !== searchSeq.current) return;
        setLoaded(true);
        if (err instanceof PairingReviewUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setItems([]);
        setTotal(0);
        setError("Zoznam sa nepodarilo načítať.");
      });
    // `onSessionExpired` je stabilná funkcia z `App.tsx` — zámerne mimo
    // závislostí, presne ako sesterské obrazovky (tento repo nemá
    // `eslint-plugin-react-hooks`, `.claude/rules/frontend-design.md`, takže
    // tu nejde o obídenie lintu — len rovnaký, dnes bežný vzor v appke).
  }, []);

  useEffect(() => {
    load(filter);
    // Filter sa mení LEN explicitným klikom nižšie (ktorý sám volá `load`) —
    // tento efekt beží iba raz pri mounte, presne ako sesterské obrazovky.
  }, []);

  const changeFilter = useCallback(
    (next: PairingReviewFilter) => {
      setFilter(next);
      try {
        window.localStorage.setItem(FILTER_STORAGE_KEY, next);
      } catch {
        // Úložisko vypnuté — appka funguje ďalej, len bez zapamätania.
      }
      window.scrollTo(0, 0);
      load(next);
    },
    [load],
  );

  // Zapamätanie scrollu (rovnaký princíp ako stará appka — `webreview/app.js`).
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    function onScroll(): void {
      if (scrollTimer.current !== undefined) clearTimeout(scrollTimer.current);
      scrollTimer.current = setTimeout(() => {
        try {
          window.localStorage.setItem(SCROLL_STORAGE_KEY, String(window.scrollY));
        } catch {
          // Úložisko vypnuté — bez zapamätania scrollu appka stále funguje.
        }
      }, 150);
    }
    window.addEventListener("scroll", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (scrollTimer.current !== undefined) clearTimeout(scrollTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      const y = Number.parseInt(window.localStorage.getItem(SCROLL_STORAGE_KEY) ?? "0", 10);
      if (y > 0) window.scrollTo(0, y);
    } catch {
      // Úložisko vypnuté — bez obnovenia scrollu appka stále funguje.
    }
    // Obnoviť scroll len RAZ, hneď po prvom úspešnom načítaní.
  }, [loaded]);

  const progressPct = gatheredTotal > 0 ? Math.round((100 * linkedTotal) / gatheredTotal) : 0;
  const showingAll = total === 0 || items.length >= total;

  return (
    <section data-testid="pairing-review-section">
      <p>
        Produkty, ktoré appka už porovnala s ponukou dodávateľov (WETLAND/BETALOV/ODIMON) — vľavo náš produkt, vpravo
        najlepší nájdený kandidát. Rozhodovanie (potvrdenie odkazu, „Nie je skladom“, „Už sa nebude predávať“) príde v
        ďalšej etape; táto obrazovka zatiaľ len ukazuje stav.
      </p>

      <div className="pairing-review-progress" data-testid="pairing-review-progress">
        <span className="pairing-review-progress-text">
          {String(linkedTotal)} / {String(gatheredTotal)} s odkazom
        </span>
        <div className="pairing-review-progress-bar">
          <div className="pairing-review-progress-bar-fill" style={{ width: `${String(progressPct)}%` }} />
        </div>
      </div>

      <div className="chip-row" data-testid="pairing-review-filters">
        {PAIRING_REVIEW_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={"chip" + (f === filter ? " active" : " chip-neutral")}
            data-testid={`pairing-review-filter-${f}`}
            onClick={() => {
              changeFilter(f);
            }}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {error !== "" && <p role="alert">{error}</p>}
      <p data-testid="pairing-review-total">
        {showingAll ? `Nájdených: ${String(total)}` : `Nájdených: ${String(total)} (zobrazených prvých ${String(items.length)})`}
      </p>

      {loaded && total === 0 ? (
        <p data-testid="pairing-review-empty">Žiadny produkt v tomto filtri.</p>
      ) : (
        <div className="pairing-review-list">
          {items.map((item) => (
            <PairingReviewCard key={item.productKey} item={item} />
          ))}
        </div>
      )}

      {items.length < total && (
        <button
          type="button"
          data-testid="load-more"
          disabled={loadMoreState.loadingMore}
          onClick={() => {
            loadMoreState.loadMore((page) => searchPairingReview({ filter: loadedFilterRef.current, page }));
          }}
        >
          {loadMoreState.loadingMore ? "Načítavam…" : `Načítať ďalšie (${String(Math.min(PAGE_SIZE, total - items.length))})`}
        </button>
      )}
    </section>
  );
}
