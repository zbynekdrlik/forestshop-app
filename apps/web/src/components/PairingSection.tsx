import { useCallback, useEffect, useRef, useState, type SyntheticEvent, type JSX } from "react";
import type { Me } from "../api.js";
import {
  confirmPairing,
  searchPairings,
  PairingUnauthorizedError,
  type PairingItem,
  type PairingState,
} from "../pairingApi.js";

const STATE_LABELS: Record<PairingItem["state"], string> = {
  navrhnute: "Navrhnuté",
  potvrdene: "Potvrdené",
};

// Rovnaké dve role, ktoré server vyžaduje pre `POST /api/pairing/confirm`
// (`requireRole("admin", "manazer")`, `pairing-routes.ts`) — server ostáva
// skutočnou bránou, toto len skrýva ovládacie prvky pre role, ktoré by aj tak
// dostali 403 (rovnaký vzor ako `OrdersSection`'s `CAN_CHANGE_STATE_ROLES`).
const CAN_CONFIRM_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

export function PairingSection({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [items, setItems] = useState<readonly PairingItem[]>([]);
  const [total, setTotal] = useState(0);
  const [searchLoaded, setSearchLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<PairingState>("all");
  const [searchError, setSearchError] = useState("");
  const canConfirm = CAN_CONFIRM_ROLES.has(role);

  // Ručné zadanie/oprava adresy pre PRÁVE JEDEN riadok naraz (rovnaký vzor
  // ako `OrdersSection`'s e-mailová úprava dodávateľa).
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  // Len najnovšia požiadavka smie zapísať výsledok — rovnaký dôvod ako
  // `CatalogPage`'s `searchSeq` (neindexovaný ILIKE nad celým katalógom môže
  // staršiu, širšiu odpoveď doručiť neskôr než novšiu, užšiu).
  const searchSeq = useRef(0);

  const search = useCallback(
    (q: string, s: PairingState) => {
      const seq = (searchSeq.current += 1);
      setSearchError("");
      searchPairings({ q, state: s, page: 1 })
        .then((result) => {
          if (seq !== searchSeq.current) return; // medzitým prišla novšia požiadavka
          setItems(result.items);
          setTotal(result.total);
          setSearchLoaded(true);
        })
        .catch((err: unknown) => {
          if (seq !== searchSeq.current) return;
          setSearchLoaded(true);
          if (err instanceof PairingUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setItems([]);
          setTotal(0);
          setSearchError("Zoznam párovania sa nepodarilo načítať.");
        });
    },
    [onSessionExpired],
  );

  useEffect(() => {
    search("", "all");
  }, [search]);

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    search(query, state);
  }

  // Na rozdiel od `OrdersSection`'s lokálnej aktualizácie stavu (tá si vystačí
  // s hodnotou, ktorú si klient sám poslal) táto tabuľka zobrazuje AJ
  // `confirmedByName`/`confirmedAt` — údaje, ktoré klient nepozná vopred (server
  // ich odvodí z prihlásenej relácie a aktuálneho času). Preto sa po úspešnom
  // potvrdení znova NAČÍTA aktuálna stránka výsledkov, rovnaký vzor ako
  // `CatalogPage`'s `runIngest` (`loadStats(); search(query, state);`) — jediný
  // spôsob, ako zobraziť AUTORITATÍVNu hodnotu bez toho, aby si klient
  // "hádal" meno/čas.
  const refetch = useCallback(() => {
    search(query, state);
  }, [search, query, state]);

  // "✓ jedným klikom" — potvrdí aktuálne uloženú/navrhnutú adresu bez zmeny.
  const confirmAsIs = useCallback(
    (item: PairingItem) => {
      if (item.supplierUrl === null) return; // tlačidlo je aj tak disabled, obranná záloha
      setActionError("");
      setBusyCode(item.variantCode);
      confirmPairing(item.variantCode)
        .then(() => {
          refetch();
        })
        .catch((err: unknown) => {
          if (err instanceof PairingUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Potvrdenie sa nepodarilo.");
        })
        .finally(() => {
          setBusyCode(null);
        });
    },
    [refetch, onSessionExpired],
  );

  const startEdit = useCallback((item: PairingItem) => {
    setEditingCode(item.variantCode);
    setUrlDraft(item.supplierUrl ?? "");
    setActionError("");
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingCode(null);
    setActionError("");
  }, []);

  // "zamietni a zadaj inú adresu ručne" — server prepíše uloženú adresu touto
  // novou a rovno ju potvrdí (viď návrhový komentár na issue 45).
  const saveManualUrl = useCallback(
    (variantCode: string) => {
      setActionError("");
      setBusyCode(variantCode);
      confirmPairing(variantCode, urlDraft.trim())
        .then(() => {
          setEditingCode(null);
          refetch();
        })
        .catch((err: unknown) => {
          if (err instanceof PairingUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Uloženie adresy sa nepodarilo.");
        })
        .finally(() => {
          setBusyCode(null);
        });
    },
    [refetch, onSessionExpired, urlDraft],
  );

  const showingAll = total === 0 || items.length >= total;

  return (
    <section>
      <h2>Kontrola párovania</h2>
      <p>
        Náš produkt oproti navrhnutej/zadanej adrese u dodávateľa — jedným klikom potvrďte zhodu,
        alebo zadajte inú adresu ručne.
      </p>

      <form onSubmit={submit}>
        {/* NIE "Kód alebo názov" — `CatalogPage.tsx` má PRESNE tento label text
            pre svoje vlastné hľadanie na tej istej stránke; `catalog.spec.ts`'s
            bare (nie exact) `getByLabel("Kód alebo názov")` by inak zrazu videl
            DVE zhody. Rovnaký gotcha ako pri "Stav" nižšie. */}
        <label htmlFor="pairing-q">Kód variantu alebo produktu</label>
        <input
          id="pairing-q"
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        {/* NIE holé "Stav" — `CatalogPage.tsx` má PRESNE ten istý label text pre
            svoj vlastný stavový filter na tej istej stránke (`App.tsx` renderuje
            obe naraz); `getByLabel("Stav", { exact: true })` (catalog.spec.ts,
            #25 vzor) by inak zrazu videl DVE zhody. Rovnaký gotcha ako
            `.claude/rules/testing.md`'s zdokumentovaná Stav/aria-label kolízia
            — rieš na strane NOVÉHO prvku (jedinečnejší label), nikdy
            obetovaním existujúceho testu. */}
        <label htmlFor="pairing-state">Stav párovania</label>
        <select
          id="pairing-state"
          value={state}
          onChange={(e) => {
            setState(e.target.value as PairingState);
          }}
        >
          <option value="all">Všetky</option>
          <option value="navrhnute">Navrhnuté</option>
          <option value="potvrdene">Potvrdené</option>
        </select>
        {/* NIE "Hľadať" — `CatalogPage.tsx` má PRESNE toto tlačidlo (rovnaký text)
            na tej istej stránke; `catalog.spec.ts`'s bare (nie exact)
            `getByRole("button", { name: "Hľadať" })` by inak zrazu videl DVE
            zhody (Playwright's name matching je substring, takže samotné
            pridanie ďalšieho slova okolo "Hľadať" by kolíziu NEVYRIEŠILO —
            treba úplne odlišné slovo). */}
        <button type="submit">Filtrovať</button>
      </form>

      {searchError !== "" && <p role="alert">{searchError}</p>}
      {actionError !== "" && <p role="alert">{actionError}</p>}
      <p data-testid="pairing-total">
        {showingAll
          ? `Nájdených: ${String(total)}`
          : `Nájdených: ${String(total)} (zobrazených prvých ${String(items.length)})`}
      </p>

      {searchLoaded && total === 0 ? (
        <p data-testid="pairing-empty">Hľadaniu nezodpovedá žiadny variant.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Kód</th>
              <th>Produkt</th>
              <th>Veľkosť</th>
              <th>Dodávateľ</th>
              <th>Adresa u dodávateľa</th>
              <th>Stav</th>
              <th>Potvrdil</th>
              {canConfirm && <th>Akcie</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.variantCode} data-testid={`pairing-${item.variantCode}`}>
                <td>{item.variantCode}</td>
                <td>{item.variantName}</td>
                <td>{item.sizeLabel ?? "—"}</td>
                <td>{item.productSupplier ?? "—"}</td>
                <td>
                  {editingCode === item.variantCode ? (
                    <>
                      <input
                        aria-label={`Adresa u dodávateľa pre ${item.variantCode}`}
                        type="url"
                        value={urlDraft}
                        disabled={busyCode === item.variantCode}
                        onChange={(e) => {
                          setUrlDraft(e.target.value);
                        }}
                      />
                      <button
                        type="button"
                        disabled={busyCode === item.variantCode || urlDraft.trim() === ""}
                        onClick={() => {
                          saveManualUrl(item.variantCode);
                        }}
                      >
                        Potvrdiť
                      </button>
                      <button type="button" disabled={busyCode === item.variantCode} onClick={cancelEdit}>
                        Zrušiť
                      </button>
                    </>
                  ) : item.supplierUrl === null ? (
                    "—"
                  ) : (
                    <a href={item.supplierUrl} target="_blank" rel="noreferrer">
                      {item.supplierUrl}
                    </a>
                  )}
                </td>
                <td>{STATE_LABELS[item.state]}</td>
                <td>
                  {item.confirmedByName === null
                    ? "—"
                    : `${item.confirmedByName} (${new Date(item.confirmedAt ?? "").toLocaleDateString("sk-SK")})`}
                </td>
                {canConfirm && (
                  <td>
                    {editingCode !== item.variantCode && (
                      <>
                        <button
                          type="button"
                          data-testid={`confirm-${item.variantCode}`}
                          disabled={item.supplierUrl === null || busyCode === item.variantCode}
                          onClick={() => {
                            confirmAsIs(item);
                          }}
                        >
                          ✓ Potvrdiť
                        </button>
                        <button
                          type="button"
                          data-testid={`reject-${item.variantCode}`}
                          disabled={busyCode === item.variantCode}
                          onClick={() => {
                            startEdit(item);
                          }}
                        >
                          ✗ Zadať inú adresu
                        </button>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
