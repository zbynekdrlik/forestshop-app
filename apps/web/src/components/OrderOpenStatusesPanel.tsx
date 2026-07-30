import { useCallback, useState, type JSX } from "react";
import {
  fetchOpenStatusesConfig,
  OrdersUnauthorizedError,
  saveOpenStatuses,
} from "../ordersApi.js";

// issue 59: nastavenie, ktoré Shoptet stavy sa počítajú ako "objednávka sa
// ešte vybavuje" (rozhoduje o obsahu zoznamu "Na objednanie"). Vydelené z
// `OrdersSection.tsx` do vlastného súboru — pridanie panela priamo tam by
// posunulo súbor cez eslint's `max-lines: 400`, rovnaký dôvod ako existujúci
// `orders-http`/`orders-http-state` split (`.claude/rules/testing.md`).
//
// Jednoduchý panel (textarea, jeden stav na riadok) — zámerne BEZ stará
// appka's `terminal`/`known_open`/`cancelled` zoznamov ani jej "impact
// preview" dialógu s počítaním pripomienkových e-mailov: táto appka (zatiaľ)
// nemá ani "Nedostupné" tab, ani pripomienkové e-maily, takže tie tri ďalšie
// zoznamy by boli špekulatívna zložitosť navyše (MVP, zavrhnutá alternatíva
// v návrhovom komentári na #59).
export function OrderOpenStatusesPanel({
  onSessionExpired,
  onSaved,
}: {
  readonly onSessionExpired: () => void;
  // Zavolané PO úspešnom uložení — `OrdersSection.tsx` ním znova načíta
  // zoznam objednávok, aby sa nová filtrácia prejavila hneď, bez reloadu.
  readonly onSaved: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Rozlišuje "načítanie zlyhalo" (nemá zmysel ukázať textarea/uložiť —
  // niet čo editovať) od "uloženie zlyhalo" (textarea MUSÍ ostať viditeľná,
  // aby sa dalo skúsiť znova) — obe cesty zdieľajú `error` nižšie na
  // zobrazenie hlášky, ale len TÁTO rozhoduje, čo sa vykreslí okolo nej.
  const [configLoaded, setConfigLoaded] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [knownStatuses, setKnownStatuses] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  const load = useCallback(() => {
    setError("");
    fetchOpenStatusesConfig()
      .then((config) => {
        setDraft(config.statuses.join("\n"));
        setKnownStatuses(config.knownStatuses);
        setConfigLoaded(true);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof OrdersUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Nastavenie otvorených stavov sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  const toggleOpen = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      if (next && !loaded) load();
      return next;
    });
  }, [load, loaded]);

  const save = useCallback(() => {
    setBusy(true);
    setError("");
    setSaveMessage("");
    // Prázdne riadky sa odfiltrujú už tu — server aj tak čistí (orez, NFC,
    // duplicity), toto len ušetrí zjavne prázdne položky pri odosielaní.
    const statuses = draft
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    saveOpenStatuses(statuses)
      .then((ulozene) => {
        setDraft(ulozene.join("\n"));
        setSaveMessage("Uložené. Zoznam 'Na objednanie' sa práve obnovuje.");
        onSaved();
      })
      .catch((err: unknown) => {
        if (err instanceof OrdersUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError(err instanceof Error ? err.message : "Uloženie sa nepodarilo.");
      })
      .finally(() => {
        setBusy(false);
      });
  }, [draft, onSaved, onSessionExpired]);

  return (
    <div className="order-open-statuses" data-testid="order-open-statuses-panel">
      <button type="button" className="btn sm ghost" onClick={toggleOpen}>
        {open ? "⌄ Skryť nastavenie stavov objednávok" : "⚙️ Nastavenie stavov objednávok"}
      </button>
      {open && (
        <div className="oos-body">
          {!loaded && <p>Načítavam nastavenie…</p>}
          {error !== "" && <p role="alert">{error}</p>}
          {/* `configLoaded`, NIE `loaded` — `loaded` je pravdivé AJ po
              ZLYHANOM prvom načítaní (inak by "Načítavam…" zostalo navždy),
              takže textarea/uložiť tlačidlo sa smú vykresliť LEN vtedy, keď
              GET skutočne priniesol dáta na editáciu. Zlyhané ULOŽENIE
              (`error` sa nastaví AŽ PO úspešnom `configLoaded`) naopak
              textarea nesmie skryť — používateľ musí vedieť skúsiť znova. */}
          {configLoaded && (
            <>
              <p className="oos-help">
                Do zoznamu "Na objednanie" sa dostanú len objednávky, ktorých stav v Shoptete je niektorý z tohto
                zoznamu (jeden stav na riadok). Ostatné objednávky zo zoznamu samy zmiznú.
              </p>
              <textarea
                className="oos-textarea"
                aria-label="Stavy objednávok, ktoré sa počítajú ako otvorené"
                data-testid="order-open-statuses-textarea"
                rows={Math.max(3, draft.split("\n").length + 1)}
                value={draft}
                disabled={busy}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSaveMessage("");
                }}
              />
              {knownStatuses.length > 0 && (
                <p className="oos-known" data-testid="order-open-statuses-known">
                  Stavy videné v objednávkach: {knownStatuses.join(" · ")}
                </p>
              )}
              <button type="button" className="btn sm good" disabled={busy} onClick={save}>
                💾 Uložiť
              </button>
              {saveMessage !== "" && <p role="status">{saveMessage}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
