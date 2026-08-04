import { useCallback, useRef, useState, type SyntheticEvent, type JSX } from "react";
import type { Me } from "../api.js";
import { validateSupplierLinkUrl } from "../ordersApi.js";
import {
  fetchProductDetail,
  globalSearch,
  SearchUnauthorizedError,
  type GlobalSearchResult,
  type ProductDetail,
  type ProductDetailVariant,
} from "../searchApi.js";
import { saveProductLink, SupplierLinksUnauthorizedError } from "../supplierLinksApi.js";

// issue 240: "Eshop → Vyhľadať" — jedno pole, ktoré hľadá naprieč katalógom aj
// objednávkami; klik na produktový výsledok otvorí detail so VŠETKÝMI jeho
// variantmi a editovateľnou dodávateľskou linkou. Editácia linky znovupoužíva
// PRESNE ten istý zápis + stavový vzor ako `SupplierLinksSection.tsx` (#239) —
// `saveProductLink` (`POST /api/product-links/:productKey`), žiadna nová
// zapisovacia cesta. Rozsah hľadania (čo sa prehľadáva a čo vedome nie) je
// zapísaný v návrhovom komentári na ticket, nie tu.
const CAN_EDIT_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

const STATE_LABELS: Record<ProductDetailVariant["state"], string> = {
  sellable: "Skladom",
  out_of_stock: "Vypredané",
  discontinued: "Predaj skončil",
};

const SUPPLIER_AVAILABILITY_LABELS: Record<"available" | "unavailable" | "unknown", string> = {
  available: "Skladom u dodávateľa",
  unavailable: "Vypredané u dodávateľa",
  unknown: "Nezistené",
};

function formatDateTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("sk-SK");
}

/** Rovnaká "uložené vs. odoslané do Shoptetu" logika ako `SupplierLinksSection.tsx`'s
 * `statusLabel` — vyvodená len z `supplierLinkUpdatedAt`/`supplierLinkSyncedAt`. */
function linkStatusLabel(detail: ProductDetail): string {
  if (detail.supplierLinkUpdatedAt === null) return detail.supplierLinkUrl === null ? "—" : "zo Shoptetu";
  const pending = detail.supplierLinkSyncedAt === null || detail.supplierLinkSyncedAt < detail.supplierLinkUpdatedAt;
  return pending
    ? "⏳ Uložené, čaká na odoslanie"
    : `✅ Odoslané do Shoptetu (${formatDateTime(detail.supplierLinkSyncedAt)})`;
}

function supplierAvailabilityLabel(variant: ProductDetailVariant): string {
  if (variant.supplierAvailabilityText !== null && variant.supplierAvailabilityText !== "") {
    return variant.supplierAvailabilityText;
  }
  if (variant.supplierAvailability === null) return "—";
  return SUPPLIER_AVAILABILITY_LABELS[variant.supplierAvailability];
}

export function SearchSection({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<GlobalSearchResult>({ products: [], orders: [] });
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState("");
  const canEdit = CAN_EDIT_ROLES.has(role);

  const [selectedProductKey, setSelectedProductKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [detailLoaded, setDetailLoaded] = useState(false);
  const [detailError, setDetailError] = useState("");

  const [editingLink, setEditingLink] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);

  // Len najnovšia požiadavka smie zapísať výsledok — rovnaký vzor ako
  // `CatalogPage.tsx`/`SupplierLinksSection.tsx`'s `searchSeq`.
  const searchSeq = useRef(0);
  const detailSeq = useRef(0);

  const search = useCallback(
    (q: string) => {
      const seq = (searchSeq.current += 1);
      setSearchError("");
      globalSearch(q)
        .then((r) => {
          if (seq !== searchSeq.current) return;
          setResult(r);
          setSearched(true);
        })
        .catch((err: unknown) => {
          if (seq !== searchSeq.current) return;
          setSearched(true);
          if (err instanceof SearchUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setResult({ products: [], orders: [] });
          setSearchError("Vyhľadávanie zlyhalo — server neodpovedal.");
        });
    },
    [onSessionExpired],
  );

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    search(query);
  }

  const openDetail = useCallback(
    (productKey: string) => {
      setSelectedProductKey(productKey);
      setDetail(null);
      setDetailLoaded(false);
      setDetailError("");
      setEditingLink(false);
      setActionError("");
      const seq = (detailSeq.current += 1);
      fetchProductDetail(productKey)
        .then((d) => {
          if (seq !== detailSeq.current) return;
          setDetail(d);
          setDetailLoaded(true);
        })
        .catch((err: unknown) => {
          if (seq !== detailSeq.current) return;
          setDetailLoaded(true);
          if (err instanceof SearchUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setDetailError("Detail produktu sa nepodarilo načítať.");
        });
    },
    [onSessionExpired],
  );

  const backToSearch = useCallback(() => {
    setSelectedProductKey(null);
    setDetail(null);
  }, []);

  const startEditLink = useCallback(() => {
    setUrlDraft(detail?.supplierLinkUrl ?? "");
    setEditingLink(true);
    setActionError("");
  }, [detail]);

  const cancelEditLink = useCallback(() => {
    setEditingLink(false);
    setActionError("");
  }, []);

  const saveLink = useCallback(() => {
    if (selectedProductKey === null) return;
    // issue 153: rovnaká OKAMŽITÁ kontrola V PREHLIADAČI ako
    // `SupplierLinksSection.tsx`/`OrderLineRow.tsx`, PRED zápisom na server.
    const validationError = validateSupplierLinkUrl(urlDraft);
    if (validationError !== null) {
      setActionError(validationError);
      return;
    }
    setBusy(true);
    setActionError("");
    const key = selectedProductKey;
    saveProductLink(key, urlDraft.trim())
      .then(() => {
        setEditingLink(false);
        return fetchProductDetail(key);
      })
      .then((d) => {
        setDetail(d);
      })
      .catch((err: unknown) => {
        if (err instanceof SupplierLinksUnauthorizedError || err instanceof SearchUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setActionError(err instanceof Error ? err.message : "Uloženie odkazu sa nepodarilo.");
      })
      .finally(() => {
        setBusy(false);
      });
  }, [selectedProductKey, urlDraft, onSessionExpired]);

  if (selectedProductKey !== null) {
    return (
      <section data-testid="search-detail-section">
        <p>
          <button type="button" className="btn sm ghost" data-testid="search-back" onClick={backToSearch}>
            ← Späť na hľadanie
          </button>
        </p>

        {!detailLoaded ? (
          <p>Načítavam…</p>
        ) : detail === null ? (
          <p role="alert" data-testid="search-detail-not-found">
            Produkt sa nenašiel.
          </p>
        ) : detailError !== "" ? (
          <p role="alert">{detailError}</p>
        ) : (
          <>
            <h3 data-testid="search-detail-name">{detail.productName}</h3>
            <p data-testid="search-detail-supplier">Dodávateľ: {detail.supplier ?? "(bez dodávateľa)"}</p>

            <div className="ord-supplier-row" data-testid="search-detail-link-row">
              <strong>Dodávateľská linka: </strong>
              {editingLink ? (
                <div className="ord-supplier-link-edit" data-testid="search-detail-link-edit">
                  <input
                    type="url"
                    className="ord-supplier-link-edit-input"
                    data-testid="search-detail-link-edit-input"
                    aria-label={`Odkaz na dodávateľa produktu ${detail.productName}`}
                    placeholder="https://…"
                    value={urlDraft}
                    disabled={busy}
                    autoFocus
                    onChange={(e) => {
                      setUrlDraft(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEditLink();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn sm good"
                    data-testid="search-detail-link-save"
                    disabled={busy || urlDraft.trim() === ""}
                    onClick={saveLink}
                  >
                    💾
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    data-testid="search-detail-link-cancel"
                    disabled={busy}
                    onClick={cancelEditLink}
                  >
                    ✖
                  </button>
                </div>
              ) : detail.supplierLinkUrl !== null ? (
                <a href={detail.supplierLinkUrl} target="_blank" rel="noreferrer noopener" data-testid="search-detail-link-value">
                  {detail.supplierLinkUrl}
                </a>
              ) : (
                <span data-testid="search-detail-link-value">—</span>
              )}
              {!editingLink && canEdit && (
                <button
                  type="button"
                  className="ord-supplier-link-edit-toggle"
                  data-testid="search-detail-link-edit-toggle"
                  aria-label={
                    detail.supplierLinkUrl !== null
                      ? `Upraviť odkaz na dodávateľa — ${detail.productName}`
                      : `Doplniť odkaz na dodávateľa — ${detail.productName}`
                  }
                  onClick={startEditLink}
                >
                  ✏️
                </button>
              )}
              <span data-testid="search-detail-link-status"> {linkStatusLabel(detail)}</span>
            </div>
            {actionError !== "" && <p role="alert">{actionError}</p>}

            <table>
              <thead>
                <tr>
                  <th>Veľkosť</th>
                  <th>Kód</th>
                  <th>Cena</th>
                  <th>Sklad</th>
                  <th>Stav u nás</th>
                  <th>Dostupnosť u dodávateľa</th>
                  <th>Adresa u nás</th>
                  <th>Kód u dodávateľa</th>
                </tr>
              </thead>
              <tbody>
                {detail.variants.map((v) => (
                  <tr key={v.code} data-testid={`search-detail-variant-${v.code}`}>
                    <td>{v.sizeLabel ?? "—"}</td>
                    <td>{v.code}</td>
                    <td>{v.price !== null ? `${v.price} ${v.currency ?? ""}` : "—"}</td>
                    <td>{v.stock}</td>
                    <td>
                      {STATE_LABELS[v.state]} ({v.availabilityText})
                    </td>
                    <td data-testid={`search-detail-supplier-stock-${v.code}`}>{supplierAvailabilityLabel(v)}</td>
                    <td>
                      {v.ourShopUrl !== null ? (
                        <a href={v.ourShopUrl} target="_blank" rel="noreferrer noopener" data-testid={`search-detail-shop-link-${v.code}`}>
                          Otvoriť
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{v.externalCode ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    );
  }

  return (
    <section data-testid="search-section">
      <p>
        Nájdite konkrétny tovar (podľa kódu, názvu, dodávateľa alebo kódu u dodávateľa) alebo objednávku
        (podľa čísla, mena či e-mailu zákazníka). Kliknutím na produkt sa otvorí jeho detail, kde sa dá
        rovno opraviť dodávateľská linka.
      </p>

      <form onSubmit={submit}>
        <label htmlFor="search-q">Hľadať</label>
        <input
          id="search-q"
          type="search"
          value={query}
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <button type="submit">Hľadať</button>
      </form>

      {searchError !== "" && <p role="alert">{searchError}</p>}

      {searched && result.products.length === 0 && result.orders.length === 0 && (
        <p data-testid="search-empty">Hľadaniu nezodpovedá nič.</p>
      )}

      {result.products.length > 0 && (
        <div data-testid="search-products">
          <h3>Produkty</h3>
          <table>
            <thead>
              <tr>
                <th>Kód</th>
                <th>Názov</th>
                <th>Dodávateľ</th>
                <th>Kód u dodávateľa</th>
                <th>Stav</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {result.products.map((p) => (
                <tr key={p.variantCode} data-testid={`search-product-${p.variantCode}`}>
                  <td>{p.variantCode}</td>
                  <td>{p.productName}</td>
                  <td>{p.supplier ?? "(bez dodávateľa)"}</td>
                  <td>{p.externalCode ?? "—"}</td>
                  <td>{STATE_LABELS[p.state]}</td>
                  <td>
                    <button
                      type="button"
                      className="btn sm ghost"
                      data-testid={`search-product-open-${p.variantCode}`}
                      onClick={() => {
                        openDetail(p.productKey);
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

      {result.orders.length > 0 && (
        <div data-testid="search-orders">
          <h3>Objednávky</h3>
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
              {result.orders.map((o) => (
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
      )}
    </section>
  );
}
