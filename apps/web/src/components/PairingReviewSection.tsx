import { useCallback, useContext, useEffect, useRef, useState, type JSX } from "react";
import type { Me } from "../api.js";
import {
  PAGE_SIZE,
  PAIRING_REVIEW_FILTERS,
  PairingReviewUnauthorizedError,
  searchPairingReview,
  type PairingReviewFilter,
  type PairingReviewItem,
} from "../pairingReviewApi.js";
import { PairingReviewBadgeRefreshContext } from "../pairingReviewBadgeContext.js";
import { useLoadMore } from "../useLoadMore.js";
import { PairingReviewCard } from "./PairingReviewCard.js";

// issue 387 E5: "Eshop → Párovanie" — čítacia obrazovka (karty + filtre) nad
// tým, čo E3 (gather)/E4 (verify) zozbierali. Design komentár na tickete
// (issue 387 E5): "unreviewed" (default filter, aj badge v `App.tsx`) =
// "produkt z gather populácie BEZ efektívnej dodávateľskej linky".
//
// issue 387 E6: pridáva rozhodovanie (`PairingReviewCard`'s akčné tlačidlá).
// Po úspešnom zápise karta zavolá `onDecided` (znova načíta AKTUÁLNY filter
// na stranu 1 — rovnaký serverový zdroj pravdy ako pri zmene filtra, žiadna
// duplicitná klientská filter-logika, design komentár na tickete) a
// `PairingReviewBadgeRefreshContext.refresh()` (odznak v menu).
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

// issue 387 E6: `role` teraz TREBA (rozhodovacie tlačidlá sa gatujú rovnako
// ako `RestockLinkSuggestionsSection.tsx`'s `CAN_EDIT_ROLES`) — plný
// `SectionProps` tvar (`nav.ts`), na rozdiel od E5's užšieho podtypu.
export function PairingReviewSection({ role, onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  const pairingReviewBadge = useContext(PairingReviewBadgeRefreshContext);
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

  // issue 387 E6 — po úspešnom rozhodnutí: znova načítaj AKTUÁLNY filter na
  // stranu 1 (rovnaký serverový zdroj pravdy, design komentár na tickete —
  // žiadna duplicitná klientská filter-logika) + odznak v menu. `load()` je
  // stabilné (prázdne závislosti), `loadedFilterRef` nesie filter, čo
  // vyprodukoval AKTUÁLNE zobrazené `items` — čítanie `.current` v ceallbacku
  // je zámerné, nie chýbajúca závislosť (ref).
  const onDecided = useCallback(() => {
    load(loadedFilterRef.current);
    pairingReviewBadge.refresh();
  }, [load, pairingReviewBadge]);

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
            <PairingReviewCard key={item.productKey} item={item} role={role} onDecided={onDecided} onSessionExpired={onSessionExpired} />
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
