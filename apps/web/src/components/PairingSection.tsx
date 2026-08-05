import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent, type JSX } from "react";
import type { Me } from "../api.js";
import {
  confirmPairing,
  searchPairings,
  PairingUnauthorizedError,
  type PairingItem,
  type PairingState,
} from "../pairingApi.js";
import {
  assertBulkConfirmSucceeded,
  groupPairingItems,
  isGroupHomogeneous,
  type ProductGroup,
} from "../pairingGroups.js";
import { PairingGroupRow } from "./PairingGroupRow.js";
import { PairingVariantRow } from "./PairingVariantRow.js";

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

  // Ručné zadanie/oprava adresy pre PRÁVE JEDEN variant naraz (rovnaký vzor
  // ako `OrdersSection`'s e-mailová úprava dodávateľa).
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [busyCode, setBusyCode] = useState<string | null>(null);
  // Bulk (per-produkt) obdoba vyššie — issue 47, F4 rozdelenie podľa
  // veľkostí. Zámerne SAMOSTATNÝ stav (nie zdieľaný s `editingCode`/
  // `busyCode`) — jednovariantný riadok aj naďalej beží presne pôvodnou
  // cestou, bulk cesta pribúda popri nej, nikdy ju nenahrádza.
  const [editingGroupKey, setEditingGroupKey] = useState<string | null>(null);
  const [groupUrlDraft, setGroupUrlDraft] = useState("");
  const [busyGroupKey, setBusyGroupKey] = useState<string | null>(null);
  // Produkty, ktoré manažér RUČNE otvoril cez "✂ Rozdeliť na veľkosti" —
  // prechodné (transient), nikdy sa nepersistuje (viď návrhový komentár na
  // issue 47). Efektívne rozdelené produkty (rôzne adresy naprieč
  // veľkosťami) sa zobrazujú rozdelené AJ BEZ prítomnosti tu.
  const [manuallyOpenedGroups, setManuallyOpenedGroups] = useState<ReadonlySet<string>>(new Set());
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
  //
  // issue 254 (súrodenec issue 251's finding — `.claude/rules/frontend-
  // design.md`'s "latest ref" záznam): `refetch` NESMIE čítať `query`/`state`
  // priamo z uzáveru — `confirmAsIs`/`saveManualUrl`/`confirmGroupAsIs`/
  // `saveManualUrlForGroup` sú KAŽDÁ zafixovaná na KONKRÉTNU inštanciu
  // `refetch` v okamihu, keď bolo príslušné tlačidlo naposledy vykreslené
  // (typicky v okamihu kliknutia). Ak sa medzitým (kým čaká na serverovú
  // odpoveď) zmení filter/dopyt, `refetch()` volaný z neskoro doručeného
  // `.then()` by aj tak zavolal `search` so STARÝMI hodnotami — a keďže
  // `searchSeq` prideľuje poradové číslo pri ZAVOLANÍ (nie pri odpovedi),
  // takýto neskorý-no-zastaraný refetch dostane VYŠŠIE číslo než medzitým
  // spustené korektné vyhľadanie a jeho výsledok by ho ticho prepísal.
  // `queryRef`/`stateRef` sa preto syncujú PRIAMO V TELE komponentu (počas
  // renderu), NIE cez `useEffect` — ten beží AŽ PO commite ako pasívny efekt
  // na samostatnom priechode, takže medzi commitom nového `query`/`state` a
  // skutočným prebehnutím efektu existuje reálne okno, počas ktorého by ref
  // ešte niesol STARÚ hodnotu; keďže `.then()` je mikrotaska, mohla by sa
  // spustiť presne v tomto okne. Bezpečné len preto, že tento strom
  // nepoužíva `startTransition`/Suspense (viď rovnaký komentár pri
  // `SupplierLinksSection.tsx`'s `queryRef`/`stateRef`).
  const queryRef = useRef(query);
  queryRef.current = query;
  const stateRef = useRef(state);
  stateRef.current = state;

  const refetch = useCallback(() => {
    search(queryRef.current, stateRef.current);
  }, [search]);

  const groups = useMemo(() => groupPairingItems(items), [items]);

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

  // issue 254 (súrodenec issue 251's code-review finding 1): `busyCode`
  // blokuje LEN tlačidlá VLASTNÉHO riadku — "✗ Zadať inú adresu" na VŠETKÝCH
  // ostatných riadkoch ostáva aktívne. Ak počas čakania na odpoveď riadku A
  // užívateľ otvorí editor riadku B, `editingCode` sa presunie na B — keby
  // `saveManualUrl`'s `.then()` nepodmienene volalo `setEditingCode(null)`,
  // ticho by zavrelo B's PRÁVE otvorený editor. Rovnaký "latest ref" princíp
  // ako `queryRef`/`stateRef` vyššie, len na `editingCode`.
  const editingKeyRef = useRef(editingCode);
  editingKeyRef.current = editingCode;

  // "zamietni a zadaj inú adresu ručne" — server prepíše uloženú adresu touto
  // novou a rovno ju potvrdí (viď návrhový komentár na issue 45).
  const saveManualUrl = useCallback(
    (variantCode: string) => {
      setActionError("");
      setBusyCode(variantCode);
      confirmPairing(variantCode, urlDraft.trim())
        .then(() => {
          if (editingKeyRef.current === variantCode) setEditingCode(null);
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

  // Bulk obdoby vyššie — issue 47: rovnaká akcia, len aplikovaná na VŠETKY
  // varianty produktu naraz (paralelné volania existujúceho `POST /api/
  // pairing/confirm`, žiadny nový backend endpoint). `refetch()` beží VŽDY,
  // aj pri čiastočnom zlyhaní — časť veľkostí mohla prejsť.
  const confirmGroupAsIs = useCallback(
    (group: ProductGroup) => {
      const url = group.variants[0]?.supplierUrl ?? null;
      if (url === null) return;
      setActionError("");
      setBusyGroupKey(group.productKey);
      const codes = group.variants.map((v) => v.variantCode);
      Promise.allSettled(codes.map((code) => confirmPairing(code)))
        .then((results) => {
          refetch();
          assertBulkConfirmSucceeded(codes, results);
        })
        .catch((err: unknown) => {
          if (err instanceof PairingUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Potvrdenie sa nepodarilo.");
        })
        .finally(() => {
          setBusyGroupKey(null);
        });
    },
    [refetch, onSessionExpired],
  );

  const startEditGroup = useCallback((group: ProductGroup) => {
    setEditingGroupKey(group.productKey);
    setGroupUrlDraft(group.variants[0]?.supplierUrl ?? "");
    setActionError("");
  }, []);

  const cancelEditGroup = useCallback(() => {
    setEditingGroupKey(null);
    setActionError("");
  }, []);

  const saveManualUrlForGroup = useCallback(
    (group: ProductGroup) => {
      setActionError("");
      setBusyGroupKey(group.productKey);
      const url = groupUrlDraft.trim();
      const codes = group.variants.map((v) => v.variantCode);
      Promise.allSettled(codes.map((code) => confirmPairing(code, url)))
        .then((results) => {
          setEditingGroupKey(null);
          refetch();
          assertBulkConfirmSucceeded(codes, results);
        })
        .catch((err: unknown) => {
          if (err instanceof PairingUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Uloženie adresy sa nepodarilo.");
        })
        .finally(() => {
          setBusyGroupKey(null);
        });
    },
    [refetch, onSessionExpired, groupUrlDraft],
  );

  const openSplit = useCallback((productKey: string) => {
    setManuallyOpenedGroups((prev) => new Set(prev).add(productKey));
  }, []);

  const closeSplit = useCallback((productKey: string) => {
    setManuallyOpenedGroups((prev) => {
      if (!prev.has(productKey)) return prev;
      const next = new Set(prev);
      next.delete(productKey);
      return next;
    });
  }, []);

  const showingAll = total === 0 || items.length >= total;

  // Jednovariantný produkt → presne dnešný riadok, nezmenené. Viacvariantný
  // produkt s ROZDIELNYMI adresami ("efektívne rozdelený") alebo ručne
  // otvorený cez "✂ Rozdeliť na veľkosti" → hlavičkový riadok produktu +
  // rovnaký per-variantný riadok pre KAŽDÚ jeho veľkosť. Inak (homogénny,
  // neotvorený) → jeden zbalený riadok s bulk akciami (issue 47).
  function renderGroup(group: ProductGroup): readonly JSX.Element[] {
    if (group.variants.length === 1) {
      const only = group.variants[0];
      if (only === undefined) return [];
      return [
        <PairingVariantRow
          key={only.variantCode}
          item={only}
          canConfirm={canConfirm}
          editingCode={editingCode}
          urlDraft={urlDraft}
          busyCode={busyCode}
          onUrlDraftChange={setUrlDraft}
          onStartEdit={startEdit}
          onCancelEdit={cancelEdit}
          onSaveManualUrl={saveManualUrl}
          onConfirmAsIs={confirmAsIs}
        />,
      ];
    }

    const homogeneous = isGroupHomogeneous(group);
    const split = !homogeneous || manuallyOpenedGroups.has(group.productKey);
    if (!split) {
      return [
        <PairingGroupRow
          key={group.productKey}
          group={group}
          canConfirm={canConfirm}
          editingGroupKey={editingGroupKey}
          groupUrlDraft={groupUrlDraft}
          busyGroupKey={busyGroupKey}
          onGroupUrlDraftChange={setGroupUrlDraft}
          onStartEditGroup={startEditGroup}
          onCancelEditGroup={cancelEditGroup}
          onSaveManualUrlForGroup={saveManualUrlForGroup}
          onConfirmGroupAsIs={confirmGroupAsIs}
          onOpenSplit={openSplit}
        />,
      ];
    }

    return [
      <tr key={`${group.productKey}-header`} data-testid={`pairing-group-header-${group.productKey}`}>
        <td colSpan={canConfirm ? 8 : 7}>
          <strong>{group.productName}</strong> — {String(group.variants.length)} veľkostí
          {homogeneous && canConfirm && (
            <button
              type="button"
              data-testid={`merge-${group.productKey}`}
              onClick={() => {
                closeSplit(group.productKey);
              }}
            >
              ↩ Zlúčiť veľkosti
            </button>
          )}
        </td>
      </tr>,
      ...group.variants.map((item) => (
        <PairingVariantRow
          key={item.variantCode}
          item={item}
          canConfirm={canConfirm}
          editingCode={editingCode}
          urlDraft={urlDraft}
          busyCode={busyCode}
          onUrlDraftChange={setUrlDraft}
          onStartEdit={startEdit}
          onCancelEdit={cancelEdit}
          onSaveManualUrl={saveManualUrl}
          onConfirmAsIs={confirmAsIs}
        />
      )),
    ];
  }

  return (
    <section>
      <h2>Kontrola párovania</h2>
      <p>
        Náš produkt oproti navrhnutej/zadanej adrese u dodávateľa — jedným klikom potvrďte zhodu,
        alebo zadajte inú adresu ručne. Produkt s viacerými veľkosťami môžete rozdeliť a nastaviť
        každej veľkosti vlastnú adresu.
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
            {groups.flatMap((group) => renderGroup(group))}
          </tbody>
        </table>
      )}
    </section>
  );
}
