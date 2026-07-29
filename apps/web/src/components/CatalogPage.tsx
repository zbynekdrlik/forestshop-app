import { useCallback, useEffect, useState, type SyntheticEvent, type JSX } from "react";
import {
  fetchCatalogStats,
  searchCatalogVariants,
  triggerCatalogIngest,
  type CatalogState,
  type CatalogStats,
  type VariantSummary,
} from "../catalogApi.js";

const STATE_LABELS: Record<VariantSummary["state"], string> = {
  sellable: "Skladom",
  out_of_stock: "Vypredané",
  discontinued: "Predaj skončil",
};

function SnapshotLine({ stats }: { readonly stats: CatalogStats }): JSX.Element {
  const snapshot = stats.lastSnapshot;
  if (snapshot === null) {
    return <p data-testid="snapshot">Katalóg zatiaľ nebol importovaný.</p>;
  }
  const cas = new Date(snapshot.fetchedAt).toLocaleString("sk-SK");
  const verdikt = snapshot.verdict === "accepted" ? "prijatý" : "odmietnutý";
  return (
    <p data-testid="snapshot">
      Posledný import: <strong>{verdikt}</strong> ({cas}) — {snapshot.rowCount} riadkov,{" "}
      {snapshot.columnCount} stĺpcov
      {snapshot.rejectionReason !== null && <> — dôvod: {snapshot.rejectionReason}</>}
    </p>
  );
}

export function CatalogPage(): JSX.Element {
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [items, setItems] = useState<readonly VariantSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<CatalogState>("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadStats = useCallback(() => {
    fetchCatalogStats()
      .then(setStats)
      .catch(() => {
        setError("Prehľad katalógu sa nepodarilo načítať.");
      });
  }, []);

  const search = useCallback((q: string, s: CatalogState) => {
    setError("");
    searchCatalogVariants({ q, state: s, page: 1 })
      .then((result) => {
        setItems(result.items);
        setTotal(result.total);
      })
      .catch(() => {
        setItems([]);
        setTotal(0);
        setError("Vyhľadávanie zlyhalo — server neodpovedal.");
      });
  }, []);

  useEffect(() => {
    loadStats();
    search("", "all");
  }, [loadStats, search]);

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    search(query, state);
  }

  function runIngest(): void {
    setBusy(true);
    setError("");
    triggerCatalogIngest()
      .then(() => {
        loadStats();
        search(query, state);
      })
      .catch(() => {
        setError("Import sa nepodarilo spustiť.");
      })
      .finally(() => {
        setBusy(false);
      });
  }

  return (
    <section>
      <h2>Katalóg</h2>
      {stats === null ? <p>Načítavam prehľad…</p> : <SnapshotLine stats={stats} />}
      {stats !== null && (
        <p data-testid="counts">
          Variantov: {stats.variantCount} · produktov: {stats.productCount} · skladom:{" "}
          {stats.sellable} · vypredaných: {stats.outOfStock} · ukončených: {stats.discontinued} ·
          chýbajúcich: {stats.missing}
        </p>
      )}

      <button type="button" onClick={runIngest} disabled={busy}>
        {busy ? "Importujem…" : "Stiahnuť a naimportovať export"}
      </button>

      <form onSubmit={submit}>
        <label htmlFor="catalog-q">Kód alebo názov</label>
        <input
          id="catalog-q"
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <label htmlFor="catalog-state">Stav</label>
        <select
          id="catalog-state"
          value={state}
          onChange={(e) => {
            setState(e.target.value as CatalogState);
          }}
        >
          <option value="all">Všetky</option>
          <option value="sellable">Skladom</option>
          <option value="out_of_stock">Vypredané</option>
          <option value="discontinued">Predaj skončil</option>
        </select>
        <button type="submit">Hľadať</button>
      </form>

      {error !== "" && <p role="alert">{error}</p>}
      <p data-testid="total">Nájdených: {total}</p>

      <table>
        <thead>
          <tr>
            <th>Kód</th>
            <th>Názov</th>
            <th>Veľkosť</th>
            <th>Stav</th>
            <th>Sklad</th>
            <th>Cena</th>
            <th>Dostupnosť podľa Shoptetu</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.code} data-testid={`variant-${item.code}`}>
              <td>{item.code}</td>
              <td>{item.name}</td>
              <td>{item.sizeLabel ?? "—"}</td>
              <td>{STATE_LABELS[item.state]}</td>
              <td>{item.stock}</td>
              <td>{item.price === null ? "—" : `${item.price} ${item.currency ?? ""}`}</td>
              <td>{item.availabilityText === "" ? "—" : item.availabilityText}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
