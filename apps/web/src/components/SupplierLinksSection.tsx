import { useCallback, useEffect, useRef, useState, type SyntheticEvent, type JSX } from "react";
import type { Me } from "../api.js";
import { formatSkDateTime } from "../formatDate.js";
import { validateSupplierLinkUrl } from "../ordersApi.js";
import {
  saveProductLink,
  searchProductLinks,
  SupplierLinksUnauthorizedError,
  type ProductLinkItem,
  type ProductLinkState,
} from "../supplierLinksApi.js";

// issue 239: "Eshop → Párovanie produktov" — priamy náprotivok
// `PairingSection.tsx`, ale kľúčovaný PRODUKTOM (nie variantom): jeden riadok
// na produkt, žiadny potvrdzovací stavový automat (majiteľ len vkladá/opravuje
// adresu), zápis ide do `product_supplier_link_override` (rovnaká tabuľka ako
// #121's riadkové priradenie), ktorú existujúci `shoptet-writeback` job (#122)
// odošle do Shoptetu — táto obrazovka doň nezapisuje žiadnou NOVOU cestou.
const CAN_EDIT_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

/**
 * Stav "uložené vs. odoslané do Shoptetu" (ticketova akceptačná podmienka) sa
 * dá vyvodiť LEN z `updatedAt`/`syncedAt` — `updatedAt === null` znamená
 * žiadny NÁŠ override (odkaz, ak existuje, prišiel priamo zo Shoptet-ovho
 * `internalNote`, appka ho nikdy neposielala, lebo tam už je). Rovnaké
 * "čaká na odoslanie" kritérium ako `select-changes.ts`'s
 * `synced_at IS NULL OR synced_at < updated_at`.
 */
function statusLabel(item: ProductLinkItem): string {
  if (item.updatedAt === null) return item.url === null ? "—" : "zo Shoptetu";
  const pending = item.syncedAt === null || item.syncedAt < item.updatedAt;
  return pending ? "⏳ Uložené, čaká na odoslanie" : `✅ Odoslané do Shoptetu (${formatSkDateTime(item.syncedAt)})`;
}

export function SupplierLinksSection({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [items, setItems] = useState<readonly ProductLinkItem[]>([]);
  const [total, setTotal] = useState(0);
  const [missingTotal, setMissingTotal] = useState(0);
  const [searchLoaded, setSearchLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<ProductLinkState>("missing");
  const [searchError, setSearchError] = useState("");
  const [actionError, setActionError] = useState("");
  const canEdit = CAN_EDIT_ROLES.has(role);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Len najnovšia požiadavka smie zapísať výsledok — rovnaký dôvod ako
  // `PairingSection.tsx`'s `searchSeq` (neindexovaný filter nad celým
  // katalógom môže staršiu, širšiu odpoveď doručiť neskôr než novšiu, užšiu).
  const searchSeq = useRef(0);

  // Code review (issue 251, finding 3): odpoveď na `search()` môže doraziť
  // AŽ PO odmountovaní tejto sekcie (napr. užívateľ medzitým prepol
  // záložku) — bez tejto stráže by `.then()`/`.catch()` zavolali `setState`
  // na už odmountovanom komponente. Nastavenie `true` MUSÍ byť aj v samotnom
  // efekte (nielen v `useRef(true)`'s počiatočnej hodnote) — React 18
  // `StrictMode` (`main.tsx`) vo VÝVOJOVOM móde efekt zámerne spustí,
  // zruší a znova spustí ("simulované odmountovanie/namountovanie"), takže
  // BEZ tohto riadku by prvé (simulované) zrušenie navždy nechalo
  // `mountedRef.current` na `false` a appka by v dev/e2e móde nikdy
  // nezapísala žiadny výsledok vyhľadávania.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const search = useCallback(
    (q: string, s: ProductLinkState) => {
      const seq = (searchSeq.current += 1);
      setSearchError("");
      searchProductLinks({ q, state: s, page: 1 })
        .then((result) => {
          if (!mountedRef.current) return; // odmountované skôr, než odpoveď doletela
          if (seq !== searchSeq.current) return; // medzitým prišla novšia požiadavka
          setItems(result.items);
          setTotal(result.total);
          setMissingTotal(result.missingTotal);
          setSearchLoaded(true);
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return;
          if (seq !== searchSeq.current) return;
          setSearchLoaded(true);
          if (err instanceof SupplierLinksUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setItems([]);
          setTotal(0);
          setSearchError("Zoznam produktov sa nepodarilo načítať.");
        });
    },
    [onSessionExpired],
  );

  useEffect(() => {
    search("", "missing");
  }, [search]);

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    search(query, state);
  }

  // issue 251: `refetch` MUSÍ vždy čítať AKTUÁLNY filter/dopyt, nie ten,
  // ktorý bol platný v okamihu, keď bol `save()`'s uzáver (nižšie) vytvorený.
  // `save()` je samostatná `useCallback` inštancia zafixovaná na tlačidle v
  // momente kliknutia — ak sa medzitým (kým čaká na PATCH odpoveď) zmení
  // filter/dopyt, `refetch` cez PRIAMY uzáver nad `query`/`state` by aj tak
  // zavolal `search` so STARÝMI hodnotami, akonáhle zápis doletí. Keďže
  // `searchSeq` prideľuje poradové číslo pri ZAVOLANÍ (nie pri odpovedi),
  // takýto neskorý-no-zastaraný refetch by mal VYŠŠIE číslo než medzitým
  // spustené korektné vyhľadanie a jeho (prázdny/starý) výsledok by ho
  // ticho prepísal — presne toto spôsobilo `element(s) not found` na main
  // CI hneď po mergi issue 241.
  //
  // Ref-sync PRIAMO v tele komponentu (počas renderu), NIE cez `useEffect`:
  // `useEffect` beží AŽ PO commite ako pasívny efekt naplánovaný na
  // samostatný priechod (React ho môže odložiť za `paint`) — medzi
  // commitom nového `query`/`state` a skutočným prebehnutím efektu existuje
  // reálne okno, počas ktorého by `queryRef.current`/`stateRef.current`
  // ešte niesli STARÚ hodnotu. Keďže `save()`'s `.then()` je mikrotaska
  // (promise callback), môže sa spustiť presne v tomto okne a prečítať
  // zastaraný ref — teda rovnaký race, aký táto oprava má odstrániť, len
  // preložený o jednu vrstvu nižšie. Priama synchrónna aktualizácia (žiadny
  // efekt, žiadne plánovanie) zaručuje, že ref nesie AKTUÁLNU hodnotu hneď
  // v momente, keď React túto funkciu tela komponentu zavolá — teda skôr,
  // než čokoľvek iné (vrátane akejkoľvek čakajúcej mikrotasky) môže ref
  // prečítať. Rovnaký "latest ref" princíp ako `.claude/rules/frontend-
  // design.md`'s "derived value instead of stale local state" (issue 151),
  // len cez ref namiesto zdvihnutia do rodiča (tu žiadny rodič netreba).
  // Code review (issue 251, finding 2): táto priama ref-mutácia POČAS
  // renderu (namiesto `useEffect`u, pozri komentár vyššie) je bezpečná LEN
  // preto, že tento strom nepoužíva `startTransition`/Suspense ani žiadnu
  // inú concurrent funkciu, ktorá by mohla render ZAHODIŤ predtým, než sa
  // commitne — vtedy by tento priamy zápis ostal vykonaný napriek
  // zahodenému renderu. Ak sa `startTransition` niekedy zavedie do tohto
  // stromu, tento vzor (aj `editingKeyRef` nižšie) treba prehodnotiť.
  const queryRef = useRef(query);
  queryRef.current = query;
  const stateRef = useRef(state);
  stateRef.current = state;

  const refetch = useCallback(() => {
    search(queryRef.current, stateRef.current);
  }, [search]);

  // Code review (issue 251, finding 1): `save()`'s `.then()` (nižšie) musí
  // vedieť, KTORÝ riadok je PRÁVE editovaný V OKAMIHU, keď odpoveď doletí —
  // nie ten, ktorý bol editovaný v momente KLIKNUTIA na Uložiť (`save` je
  // sama osebe zafixovaná na `productKey` parametri cez uzáver, to je v
  // poriadku; problém je čítanie `editingKey`). Rovnaký "latest ref" dôvod
  // ako `queryRef`/`stateRef` vyššie — synchrónne priamo v tele komponentu,
  // nie cez `useEffect`.
  const editingKeyRef = useRef(editingKey);
  editingKeyRef.current = editingKey;

  const startEdit = useCallback((item: ProductLinkItem) => {
    setEditingKey(item.productKey);
    setUrlDraft(item.url ?? "");
    setActionError("");
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingKey(null);
    setActionError("");
  }, []);

  const save = useCallback(
    (productKey: string) => {
      setActionError("");
      // issue 153: OKAMŽITÁ kontrola V PREHLIADAČI, PRED zápisom na server —
      // zdieľaná s `orders/supplier-link` obrazovkou (`ordersApi.ts`'s
      // `validateSupplierLinkUrl`), rovnaké pravidlo na oboch miestach.
      const validationError = validateSupplierLinkUrl(urlDraft);
      if (validationError !== null) {
        setActionError(validationError);
        return;
      }
      setBusyKey(productKey);
      saveProductLink(productKey, urlDraft.trim())
        .then(() => {
          // issue 251 (finding 1): `busyKey` blokuje LEN tlačidlá TOHTO
          // riadku — Upraviť/Doplniť na VŠETKÝCH ostatných riadkoch ostáva
          // aktívne. Kým táto odpoveď čakala, užívateľ mohol otvoriť INÝ
          // riadok (`editingKey` sa presunul na neho) — vtedy toto
          // zatvorenie NESMIE prebehnúť, inak by ticho zavrelo CUDZÍ,
          // práve rozpísaný editor.
          if (editingKeyRef.current === productKey) setEditingKey(null);
          refetch();
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
    [refetch, onSessionExpired, urlDraft],
  );

  const showingAll = total === 0 || items.length >= total;

  return (
    <section data-testid="product-links-section">
      <p>
        Produkty, ktoré nemajú dodávateľskú linku, nevie automat sledovať dostupnosť u dodávateľa —
        preto nefunguje ani „Vypredané → Skladom“, ani „Na objednanie“ pre ne. Vložte alebo opravte
        adresu produktu u dodávateľa, uloženie ju pošle do Shoptetu.
      </p>

      <p className="chip-row">
        <span className="chip" data-testid="product-links-missing-total">
          Bez linky celkom: {missingTotal}
        </span>
      </p>

      <form onSubmit={submit}>
        <label htmlFor="product-links-q">Hľadať produkt (kód alebo názov)</label>
        <input
          id="product-links-q"
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <label htmlFor="product-links-state">Zobraziť produkty</label>
        <select
          id="product-links-state"
          value={state}
          onChange={(e) => {
            setState(e.target.value as ProductLinkState);
          }}
        >
          <option value="missing">Bez linky</option>
          <option value="linked">S linkou</option>
          <option value="all">Všetky</option>
        </select>
        <button type="submit">Zobraziť</button>
      </form>

      {searchError !== "" && <p role="alert">{searchError}</p>}
      {actionError !== "" && <p role="alert">{actionError}</p>}
      <p data-testid="product-links-total">
        {showingAll
          ? `Nájdených: ${String(total)}`
          : `Nájdených: ${String(total)} (zobrazených prvých ${String(items.length)})`}
      </p>

      {searchLoaded && total === 0 ? (
        <p data-testid="product-links-empty">Hľadaniu nezodpovedá žiadny produkt.</p>
      ) : (
        <div className="fs-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Kód</th>
              <th>Názov</th>
              <th>Dodávateľ</th>
              <th>Variantov</th>
              <th>Odkaz na dodávateľa</th>
              <th>Stav</th>
              {canEdit && <th>Akcie</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const editing = editingKey === item.productKey;
              const busyHere = busyKey === item.productKey;
              return (
                <tr key={item.productKey} data-testid={`product-link-row-${item.productKey}`}>
                  <td>{item.productKey}</td>
                  <td>{item.productName}</td>
                  <td>{item.supplier ?? "(bez dodávateľa)"}</td>
                  <td>{item.variantCount}</td>
                  <td>
                    {editing ? (
                      <div className="ord-supplier-link-edit" data-testid={`product-link-edit-${item.productKey}`}>
                        <input
                          type="url"
                          className="ord-supplier-link-edit-input"
                          data-testid={`product-link-edit-input-${item.productKey}`}
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
                          data-testid={`product-link-save-${item.productKey}`}
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
                          data-testid={`product-link-cancel-${item.productKey}`}
                          aria-label="Zrušiť úpravu"
                          disabled={busyHere}
                          onClick={cancelEdit}
                        >
                          ✖
                        </button>
                      </div>
                    ) : item.url !== null ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        data-testid={`product-link-url-${item.productKey}`}
                      >
                        {item.url}
                      </a>
                    ) : (
                      <span data-testid={`product-link-url-${item.productKey}`}>—</span>
                    )}
                  </td>
                  <td data-testid={`product-link-status-${item.productKey}`}>{statusLabel(item)}</td>
                  {canEdit && (
                    <td>
                      {!editing && (
                        <button
                          type="button"
                          className="btn sm ghost"
                          data-testid={`product-link-edit-toggle-${item.productKey}`}
                          aria-label={
                            item.url !== null
                              ? `Upraviť odkaz na dodávateľa — ${item.productName} (${item.productKey})`
                              : `Doplniť odkaz na dodávateľa — ${item.productName} (${item.productKey})`
                          }
                          onClick={() => {
                            startEdit(item);
                          }}
                        >
                          {item.url !== null ? "✏️ Upraviť" : "✏️ Doplniť"}
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
    </section>
  );
}
