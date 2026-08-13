import { useCallback, useRef, useState, type JSX } from "react";
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

// issue 387 E5: karta jedného produktu, vyčlenená VOPRED z `PairingReviewSection.tsx`
// (rovnaký princíp ako `OrderLineRow.tsx`/`UpozornenieCard.tsx` — dvojstĺpcová
// karta má dosť JSX na prekročenie eslint `max-lines: 400` v jednom súbore,
// `.claude/rules/frontend-design.md`).
//
// issue 387 E6: pridáva rozhodovanie — presne UX starej appky (design
// komentár na tickete): ✓ Dobré / ✗ Zlé (✗ len ROZBALÍ panel na mieste,
// NEPRESÚVA kartu), panel so zoznamom top-8 kandidátov ("Vybrať"), ručné URL
// pole ("Uložiť"), 📦/🚫 terminálne stavy, ↩ Vrátiť + "Zmeniť" pri už
// rozhodnutých. Panel je PER-KARTE lokálny stav (žiadny globálny
// `editingXId` scalar) — issue 381's krížová strata konceptu sa netýka.
// VŠETKY akčné tlačidlá zdieľajú JEDEN `busy` guard.

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

  // "Latest ref" vzor (`.claude/rules/frontend-design.md`) — panel sa môže
  // zavrieť/znovu otvoriť skôr, než dobehne pôvodný `fetchPairingCandidates`.
  const openSeq = useRef(0);

  const openPanel = useCallback(() => {
    const seq = (openSeq.current += 1);
    setPanelOpen(true);
    setActionError("");
    setCandidatesError("");
    // Predvyplní vlastnú URL len keď ide o EXISTUJÚCE manuálne rozhodnutie,
    // čo NESEDÍ so žiadnym kandidátom (rovnaký vzor ako stará appka's
    // `resolutionPanel`) — inak prázdne, nikdy neuhádnuté.
    setManualUrl(item.decision?.status === "manual" ? (item.decision.url ?? "") : "");
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
  }, [item.productKey, item.decision, onSessionExpired]);

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

  return (
    <div className="card pairing-review-card" data-testid={`pairing-review-card-${item.productKey}`}>
      <div className="pairing-review-grid">
        <div className="pairing-review-side">
          <div className="pairing-review-label">Náš produkt</div>
          <a
            className="pairing-review-name"
            href={item.ourUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`pairing-review-our-link-${item.productKey}`}
          >
            {item.productName}
          </a>
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
          <div className="pairing-review-label">Navrhnutý kandidát</div>
          {item.chosenCandidate === null ? (
            <p className="pairing-review-nocandidate" data-testid={`pairing-review-no-candidate-${item.productKey}`}>
              Nenašiel sa žiadny kandidát u dodávateľa.
            </p>
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
                  <button type="button" className="btn bad sm" disabled={busy} onClick={openPanel} data-testid={`pairing-review-open-panel-${item.productKey}`}>
                    ✗ Zlé
                  </button>
                </div>
              )}

              {/* Bez kandidáta niet čo "prijať" — panel (kandidáti/manuál/terminálne stavy) sa ukazuje priamo, presne ako stará appka. */}
              {(panelOpen || (item.decision === null && item.chosenCandidate === null)) && (
                <div className="pairing-review-panel" data-testid={`pairing-review-panel-${item.productKey}`}>
                  {candidatesError !== "" && <p role="alert">{candidatesError}</p>}
                  {candidates === null && candidatesError === "" && <p>Načítavam kandidátov…</p>}
                  {candidates !== null &&
                    candidates.map((c, i) => (
                      <div key={c.url} className="pairing-review-panel-candidate">
                        <span>
                          {c.name}: {c.url}
                          {c.codeHit && " (kód sedí)"}
                        </span>
                        <button
                          type="button"
                          className="btn good sm"
                          disabled={busy}
                          onClick={() => {
                            submit({ status: "manual", url: c.url });
                          }}
                          data-testid={`pairing-review-panel-pick-${item.productKey}-${String(i)}`}
                        >
                          Vybrať
                        </button>
                      </div>
                    ))}

                  <div className="pairing-review-manual-row">
                    <input
                      type="url"
                      placeholder="Vlož vlastnú URL dodávateľa…"
                      value={manualUrl}
                      disabled={busy}
                      data-testid={`pairing-review-manual-input-${item.productKey}`}
                      onChange={(e) => {
                        setManualUrl(e.target.value);
                      }}
                    />
                    <button
                      type="button"
                      className="btn good sm"
                      disabled={busy || manualUrl.trim() === ""}
                      onClick={saveManual}
                      data-testid={`pairing-review-manual-save-${item.productKey}`}
                    >
                      Uložiť URL
                    </button>
                  </div>

                  <div className="pairing-review-terminal-row">
                    <button
                      type="button"
                      className="btn warn sm"
                      disabled={busy}
                      onClick={() => {
                        submit({ status: "unavailable" });
                      }}
                      data-testid={`pairing-review-unavailable-${item.productKey}`}
                      title="visible + Vypredané, stock 0 — dočasne, ostáva na re-kontrolu"
                    >
                      📦 Nie je skladom
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busy}
                      onClick={() => {
                        submit({ status: "discontinued" });
                      }}
                      data-testid={`pairing-review-discontinued-${item.productKey}`}
                      title="detailOnly + Predaj výrobku skončil — link ostane pre Google"
                    >
                      🚫 Už sa nebude predávať
                    </button>
                  </div>

                  {panelOpen && (
                    <button type="button" className="btn ghost sm" disabled={busy} onClick={closePanel} data-testid={`pairing-review-panel-cancel-${item.productKey}`}>
                      Zavrieť
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
