import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { validateSupplierLinkUrl } from "../ordersApi.js";
import {
  fetchPairingCandidates,
  PairingReviewUnauthorizedError,
  sendPairingDecision,
  type PairingDecisionAction,
  type PairingReviewCandidate,
  type PairingReviewItem,
} from "../pairingReviewApi.js";
import { PairingReviewDecisionPanel } from "./PairingReviewDecisionPanel.js";
import { TerminalButtons } from "./PairingReviewPanelParts.js";
import { PairingReviewSplitPanel } from "./PairingReviewSplitPanel.js";

// issue 387 E5: karta jedného produktu, vyčlenená VOPRED z `PairingReviewSection.tsx`
// (rovnaký princíp ako `OrderLineRow.tsx`/`UpozornenieCard.tsx` — dvojstĺpcová
// karta má dosť JSX na prekročenie eslint `max-lines: 400` v jednom súbore,
// `.claude/rules/frontend-design.md`).
//
// issue 398: posledná podoba starej appky (`parovanie-produktov` @ f76cafa,
// commit `f45af65`) nahradila mätúci medzikrok „✗ Zlé" priamymi tlačidlami
// NA KARTE — nerozhodnutá karta s kandidátom ukazuje VŠETKY možnosti naraz
// (✓ Dobré / „vyber url" / 📦 / 🚫), žiadny medzikrok. „vyber url" (predtým
// „✗ Zlé") má PRESNE rovnaké správanie ako predtým — len ROZBALÍ panel na
// mieste (NEPRESÚVA kartu, NEMENÍ stav), teraz len s iným labelom a bez
// zbytočného "zlé" rámovania. Panel (kandidáti/manuál/📦/🚫/Zavrieť) sa
// ukazuje aj priamo, keď karta nemá kandidáta vôbec. Panel je PER-KARTE
// lokálny stav (žiadny globálny `editingXId` scalar) — issue 381's krížová
// strata konceptu sa netýka. VŠETKY akčné tlačidlá zdieľajú JEDEN `busy` guard.
//
// issue 401: `item.supplierHasAdapter === false` (dodávateľ bez
// automatického adaptéra WETLAND/BETALOV/ODIMON) dostáva VLASTNÚ hlášku
// namiesto "Nenašiel sa žiadny kandidát" — karta inak vyzerá identicky
// (manuálne URL pole + 📦/🚫 sú tie isté možnosti z #398).
//
// issue 409: panel kandidátov ukazuje obrázok KAŽDÉHO z top-8 (dáta sú UŽ
// perzistované z gather behu — žiadny live-fetch navyše, design komentár).
//
// Design komentár (root cause/prístup/zamietnutá alternatíva/Architektúra)
// pre #398/#401/#409: https://github.com/zbynekdrlik/forestshop-app/issues/398

const STATE_LABELS: Readonly<Record<PairingReviewItem["productState"], string>> = {
  sellable: "🟢 Skladom",
  out_of_stock: "📦 Nie je skladom",
  discontinued: "🚫 Už sa nebude predávať",
};

const CONFIDENCE_LABELS: Readonly<Record<PairingReviewItem["confidence"], string>> = {
  high: "vysoká istota",
  medium: "stredná istota",
  low: "nízka istota",
  none: "žiadna",
};

const VERDICT_LABELS: Readonly<Record<NonNullable<PairingReviewItem["verdict"]>, string>> = {
  ok: "✓ kód overený na stránke",
  unsure: "kód sa na stránke nenašiel",
};

const DECISION_BADGE_LABELS: Readonly<Record<NonNullable<PairingReviewItem["decision"]>["status"], string>> = {
  good: "✓ Dobré",
  manual: "✓ Vybraný link",
  unavailable: "📦 Nie je skladom",
  discontinued: "🚫 Už sa nebude predávať",
  split: "✂ Rozdelené na veľkosti",
};

const CAN_EDIT_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

function formatPriceRange(item: PairingReviewItem): string | null {
  if (item.priceMin === null || item.priceMax === null) return null;
  const currencySuffix = item.currency !== null && item.currency !== "" && item.currency !== "EUR" ? ` ${item.currency}` : " €";
  if (item.priceMin === item.priceMax) return `${item.priceMin}${currencySuffix}`;
  return `${item.priceMin}–${item.priceMax}${currencySuffix}`;
}

export function PairingReviewCard({
  item,
  role,
  onDecided,
  onSessionExpired,
}: {
  readonly item: PairingReviewItem;
  readonly role: Me["role"];
  readonly onDecided: () => void;
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const priceRange = formatPriceRange(item);
  const codes = item.externalCodes.length > 0 ? item.externalCodes.join(", ") : "—";
  const canEdit = CAN_EDIT_ROLES.has(role);

  const [panelOpen, setPanelOpen] = useState(false);
  const [candidates, setCandidates] = useState<readonly PairingReviewCandidate[] | null>(null);
  const [candidatesError, setCandidatesError] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  // issue 399 — "✂ Rozdeliť na veľkosti": prechodný (transient) stav, či
  // manažér PRÁVE TERAZ otvoril split editor — rovnaký princíp ako stará
  // appky's `splitOpen` Set, len tu PER-KARTE `useState` (karta je od E6
  // stavová per-inštancia, `.claude/rules/pairing-search.md`). Editor sa
  // ukazuje AJ keď `!splitOpen`, ale produkt UŽ MÁ `decision.status ===
  // "split"` — `showSplitPanel` nižšie zjednocuje oba prípady.
  const [splitOpen, setSplitOpen] = useState(false);

  // "Latest ref" vzor (`.claude/rules/frontend-design.md`) — panel sa môže
  // zavrieť/znovu otvoriť skôr, než dobehne pôvodný `fetchPairingCandidates`.
  const openSeq = useRef(0);

  // issue 398/401 review nález: panel sa ukazuje AJ AUTOMATICKY (bez kliku na
  // "vyber url"), keď karta nemá kandidáta vôbec — pred touto opravou sa v
  // tom prípade `fetchPairingCandidates` NIKDY nezavolalo (volalo sa len z
  // `openPanel`u), takže "Načítavam kandidátov…" ostávalo navždy zobrazené aj
  // keď v skutočnosti niet čo načítať (item.chosenCandidate === null vždy
  // znamená `confidence === "none"`, teda top-8 zoznam je prázdny — `.claude/
  // rules/pairing-search.md`'s E5 sekcia). issue 401 tento stav sprístupnilo
  // OVEĽA ČASTEJŠIE (každý produkt bez adaptéra ho má), preto oprava patrí sem.
  const loadCandidates = useCallback(() => {
    const seq = (openSeq.current += 1);
    setCandidatesError("");
    setCandidates(null);
    fetchPairingCandidates(item.productKey)
      .then((result) => {
        if (seq !== openSeq.current) return;
        setCandidates(result);
      })
      .catch((err: unknown) => {
        if (seq !== openSeq.current) return;
        if (err instanceof PairingReviewUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setCandidatesError("Zoznam kandidátov sa nepodarilo načítať.");
      });
  }, [item.productKey, onSessionExpired]);

  const openPanel = useCallback(() => {
    setPanelOpen(true);
    setSplitOpen(false); // vzájomne sa vylučujúce editory na jednej karte
    setActionError("");
    // Predvyplní vlastnú URL len keď ide o EXISTUJÚCE manuálne rozhodnutie,
    // čo NESEDÍ so žiadnym kandidátom (rovnaký vzor ako stará appka's
    // `resolutionPanel`) — inak prázdne, nikdy neuhádnuté.
    setManualUrl(item.decision?.status === "manual" ? (item.decision.url ?? "") : "");
    loadCandidates();
  }, [item.decision, loadCandidates]);

  // issue 399 — "✂ Rozdeliť na veľkosti" trigger: zdieľa TEN ISTÝ
  // `loadCandidates()` ako "vyber url" (top-8 kandidátov slúžia ako
  // quick-picky PER veľkosť v `PairingReviewSplitPanel.tsx`, žiadny druhý fetch).
  const openSplit = useCallback(() => {
    setSplitOpen(true);
    setPanelOpen(false);
    setActionError("");
    loadCandidates();
  }, [loadCandidates]);

  const autoShowsPanel = item.decision === null && item.chosenCandidate === null;
  // Beží pri MOUNTE (keď karta odrazu štartuje v "bez kandidáta" stave) AJ
  // pri KAŽDOM prechode false→true PO mounte (napr. "↩ Vrátiť" na produkte
  // bez kandidáta vráti `decision` na `null`, karta ostáva TOU ISTOU
  // inštanciou — žiadny remount, žiadny iný spúšťač by fetch nespustil).
  // Pole závislostí je ÚPLNÉ (tento repo nemá `eslint-plugin-react-hooks`,
  // `.claude/rules/frontend-design.md` — kontrola je ručná, nie lintová):
  // `loadCandidates` je stabilné (memoizované na `[item.productKey,
  // onSessionExpired]`, oboje stabilné hodnoty).
  useEffect(() => {
    if (autoShowsPanel) loadCandidates();
  }, [autoShowsPanel, loadCandidates]);

  const closePanel = useCallback(() => {
    openSeq.current += 1; // zahodí prípadnú ešte-bežiacu odpoveď na kandidátov
    setPanelOpen(false);
    setActionError("");
  }, []);

  const submit = useCallback(
    (action: PairingDecisionAction) => {
      setActionError("");
      setBusy(true);
      sendPairingDecision(item.productKey, action)
        .then(() => {
          setPanelOpen(false);
          setSplitOpen(false); // úspešné "split"/"revert" zavrie prechodný split editor
          onDecided();
        })
        .catch((err: unknown) => {
          if (err instanceof PairingReviewUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Uloženie rozhodnutia sa nepodarilo.");
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [item.productKey, onDecided, onSessionExpired],
  );

  const saveManual = useCallback(() => {
    const trimmed = manualUrl.trim();
    const validationError = validateSupplierLinkUrl(trimmed);
    if (validationError !== null) {
      setActionError(validationError);
      return;
    }
    submit({ status: "manual", url: trimmed });
  }, [manualUrl, submit]);

  // issue 399 — zjednocuje "editor PRÁVE TERAZ otvorený" (`splitOpen`) s
  // "produkt UŽ MÁ rozhodnutie split" (rovnaký princíp ako stará appky's
  // `splitOpen.has(p.key) || s === 'split'`).
  const showSplitPanel = splitOpen || item.decision?.status === "split";

  return (
    <div className="card pairing-review-card" data-testid={`pairing-review-card-${item.productKey}`}>
      <div className="pairing-review-grid">
        <div className="pairing-review-side">
          <div className="pairing-review-label">Náš produkt</div>
          <a
            className={item.ourUrlIsSearchFallback ? "pairing-review-name pairing-review-name-fallback" : "pairing-review-name"}
            href={item.ourUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`pairing-review-our-link-${item.productKey}`}
            title={item.ourUrlIsSearchFallback ? "Priama adresa produktu nie je známa — otvorí vyhľadávanie na eshope" : undefined}
          >
            {item.productName}
          </a>
          {/* issue 402: majiteľ — "otvorí sa vyhľadávanie namiesto produktu" —
              odkaz vyššie preto pri fallbacku NEVYZERÁ ako priamy odkaz
              (tlmená farba/prerušovaná čiara) A dostáva TÚTO explicitnú
              poznámku, aby farba nebola jediný signál. */}
          {item.ourUrlIsSearchFallback && (
            <div className="pairing-review-fallback-note" data-testid={`pairing-review-fallback-note-${item.productKey}`}>
              🔎 hľadať na eshope — priama adresa nie je známa
            </div>
          )}
          <div className="pairing-review-meta">
            {item.supplier ?? "(bez dodávateľa)"} · kódy: {codes} · {String(item.variantCount)} variant(ov)
          </div>
          <span
            className={"pairing-review-state-badge pairing-review-state-" + item.productState}
            data-testid={`pairing-review-state-${item.productKey}`}
          >
            {STATE_LABELS[item.productState]}
          </span>
          {priceRange !== null && <div className="pairing-review-price">💶 {priceRange}</div>}
          <div className="pairing-review-imgbox">
            {item.ourImageUrl !== null ? (
              <img src={item.ourImageUrl} alt={item.productName} loading="lazy" />
            ) : (
              <span className="pairing-review-noimg">bez obrázka</span>
            )}
          </div>
        </div>

        <div className="pairing-review-side">
          {/* issue 399 — split editor (transientne otvorený, ALEBO produkt
              UŽ MÁ decision.status === "split") NAHRADÍ CELÚ pravú stranu,
              presne ako stará appky's `splitOpen.has(p.key) || s === 'split'`
              early-return v `renderCard`. */}
          {showSplitPanel ? (
            <>
              <div className="pairing-review-label">Rozdelenie na veľkosti</div>
              {item.decision?.status === "split" && (
                <span
                  className="pairing-review-decision-badge pairing-review-decision-split"
                  data-testid={`pairing-review-decision-badge-${item.productKey}`}
                >
                  {DECISION_BADGE_LABELS.split}
                </span>
              )}
              {canEdit && (
                <PairingReviewSplitPanel
                  item={item}
                  busy={busy}
                  submit={submit}
                  candidates={candidates}
                  candidatesError={candidatesError}
                  onSessionExpired={onSessionExpired}
                />
              )}
            </>
          ) : (
            <>
              <div className="pairing-review-label">Navrhnutý kandidát</div>
              {item.chosenCandidate === null ? (
                item.supplierHasAdapter ? (
                  <p className="pairing-review-nocandidate" data-testid={`pairing-review-no-candidate-${item.productKey}`}>
                    Nenašiel sa žiadny kandidát u dodávateľa.
                  </p>
                ) : (
                  // issue 401 — dodávateľ NEMÁ automatický adaptér (nie
                  // WETLAND/BETALOV/ODIMON) — gather preň vôbec nebehal, na
                  // rozdiel od "gather behal, nič nenašiel" vyššie.
                  <p className="pairing-review-nocandidate" data-testid={`pairing-review-no-adapter-${item.productKey}`}>
                    Tento dodávateľ zatiaľ nemá automatické vyhľadávanie — link treba zadať ručne.
                  </p>
                )
              ) : (
                <div data-testid={`pairing-review-candidate-${item.productKey}`}>
                  <a
                    className="pairing-review-name"
                    href={item.chosenCandidate.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`pairing-review-candidate-link-${item.productKey}`}
                  >
                    {item.chosenCandidate.name}
                  </a>
                  <div className="pairing-review-meta">
                    skóre {item.chosenCandidate.rawScore.toFixed(1)} · {CONFIDENCE_LABELS[item.confidence]}
                    {item.chosenCandidate.codeHit && " · kód sedí"}
                  </div>
                  {item.verdict !== null && (
                    <div className={"pairing-review-verdict pairing-review-verdict-" + item.verdict} data-testid={`pairing-review-verdict-${item.productKey}`}>
                      {VERDICT_LABELS[item.verdict]}
                    </div>
                  )}
                  <div className="pairing-review-imgbox">
                    {item.chosenCandidate.imageUrl !== null ? (
                      <img src={item.chosenCandidate.imageUrl} alt={item.chosenCandidate.name} loading="lazy" />
                    ) : (
                      <span className="pairing-review-noimg">bez obrázka</span>
                    )}
                  </div>
                </div>
              )}

              {!canEdit ? (
                item.decision !== null && (
                  <span
                    className={"pairing-review-decision-badge pairing-review-decision-" + item.decision.status}
                    data-testid={`pairing-review-decision-badge-${item.productKey}`}
                  >
                    {DECISION_BADGE_LABELS[item.decision.status]}
                  </span>
                )
              ) : (
                <>
                  {actionError !== "" && <p role="alert">{actionError}</p>}

                  {item.decision !== null && !panelOpen && (
                    <div className="pairing-review-actions">
                      <span
                        className={"pairing-review-decision-badge pairing-review-decision-" + item.decision.status}
                        data-testid={`pairing-review-decision-badge-${item.productKey}`}
                      >
                        {DECISION_BADGE_LABELS[item.decision.status]}
                      </span>
                      {(item.decision.status === "good" || item.decision.status === "manual") && (
                        <button type="button" className="btn ghost sm" disabled={busy} onClick={openPanel} data-testid={`pairing-review-change-${item.productKey}`}>
                          ✗ Zmeniť / iný link
                        </button>
                      )}
                      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { submit({ status: "revert" }); }} data-testid={`pairing-review-revert-${item.productKey}`}>
                        ↩ Vrátiť
                      </button>
                    </div>
                  )}

                  {/* issue 398 — vysvetlenie dôsledku pri už rozhodnutom
                      terminálnom stave: appka SAMA nič na eshope nemení hneď,
                      reálne prepnutie robí nočná automatika (E7 stavový writeback). */}
                  {item.decision !== null && !panelOpen && (item.decision.status === "unavailable" || item.decision.status === "discontinued") && (
                    <p className="pairing-review-terminal-note" data-testid={`pairing-review-terminal-note-${item.productKey}`}>
                      Reálne prepnutie viditeľnosti na eshope urobí nočná automatika (stavový zápis) — toto rozhodnutie je len príprava naň.
                    </p>
                  )}

                  {/* issue 398 — posledná podoba starej appky: KOLEKTÍVNY riadok
                      všetkých možností priamo na karte, žiadny "✗ Zlé" medzikrok. */}
                  {item.decision === null && item.chosenCandidate !== null && !panelOpen && (
                    <div className="pairing-review-actions">
                      <button
                        type="button"
                        className="btn good sm"
                        disabled={busy}
                        onClick={() => {
                          submit({ status: "good" });
                        }}
                        data-testid={`pairing-review-good-${item.productKey}`}
                      >
                        ✓ Dobré
                      </button>
                      <button type="button" className="btn ghost sm" disabled={busy} onClick={openPanel} data-testid={`pairing-review-open-panel-${item.productKey}`}>
                        vyber url
                      </button>
                      <TerminalButtons busy={busy} submit={submit} productKey={item.productKey} />
                    </div>
                  )}

                  {/* issue 399 — "✂ Rozdeliť na veľkosti": dostupné VŽDY, kým
                      produkt nemá rozhodnutie a má viac než 1 veľkosť —
                      nezávisle od toho, či má navrhnutého kandidáta (rovnaký
                      zámer ako stará appky's `splitButton`). */}
                  {item.decision === null && item.variantCount > 1 && !panelOpen && (
                    <div className="pairing-review-actions">
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy}
                        onClick={openSplit}
                        title="Nastaviť iný dodávateľský link pre každú veľkosť"
                        data-testid={`pairing-review-split-${item.productKey}`}
                      >
                        ✂ Rozdeliť na veľkosti
                      </button>
                    </div>
                  )}

                  {/* Bez kandidáta niet čo "prijať" — panel (kandidáti/manuál/terminálne stavy) sa ukazuje priamo, presne ako stará appka. */}
                  {(panelOpen || (item.decision === null && item.chosenCandidate === null)) && (
                    <PairingReviewDecisionPanel
                      productKey={item.productKey}
                      busy={busy}
                      candidatesError={candidatesError}
                      candidates={candidates}
                      manualUrl={manualUrl}
                      onManualUrlChange={setManualUrl}
                      onSaveManual={saveManual}
                      submit={submit}
                      panelOpen={panelOpen}
                      onClose={closePanel}
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
