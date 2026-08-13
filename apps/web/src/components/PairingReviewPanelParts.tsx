import type { JSX } from "react";
import type { PairingDecisionAction, PairingReviewCandidate } from "../pairingReviewApi.js";

// issue 398/409 — vyčlenené z `PairingReviewCard.tsx` (eslint `max-lines: 400`,
// `.claude/rules/frontend-design.md`'s zavedený vzor "component file that grows
// past the cap gets its repeated per-item rendering unit extracted"). Dve malé,
// bezstavové zložky zdieľané DVOMA miestami v `PairingReviewCard.tsx`:
// `TerminalButtons` (priamy riadok na karte AJ panel — vzájomne vylučujúce v
// DOM-e, zdieľajú testid) a `PanelCandidateRow` (jeden riadok top-8 zoznamu v
// rozbaľovacom paneli, teraz s obrázkom kandidáta — issue 409).

export function TerminalButtons({
  busy,
  submit,
  productKey,
}: {
  readonly busy: boolean;
  readonly submit: (action: PairingDecisionAction) => void;
  readonly productKey: string;
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        className="btn warn sm"
        disabled={busy}
        onClick={() => {
          submit({ status: "unavailable" });
        }}
        data-testid={`pairing-review-unavailable-${productKey}`}
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
        data-testid={`pairing-review-discontinued-${productKey}`}
        title="detailOnly + Predaj výrobku skončil — link ostane pre Google"
      >
        🚫 Už sa nebude predávať
      </button>
    </>
  );
}

export function PanelCandidateRow({
  candidate,
  index,
  busy,
  submit,
  productKey,
}: {
  readonly candidate: PairingReviewCandidate;
  readonly index: number;
  readonly busy: boolean;
  readonly submit: (action: PairingDecisionAction) => void;
  readonly productKey: string;
}): JSX.Element {
  return (
    <div className="pairing-review-panel-candidate">
      <div className="pairing-review-panel-candidate-imgbox">
        {candidate.imageUrl !== null ? (
          <img src={candidate.imageUrl} alt={candidate.name} loading="lazy" />
        ) : (
          <span className="pairing-review-noimg">bez obrázka</span>
        )}
      </div>
      <span className="pairing-review-panel-candidate-text">
        {candidate.name}: {candidate.url}
        {candidate.codeHit && " (kód sedí)"}
      </span>
      <button
        type="button"
        className="btn good sm"
        disabled={busy}
        onClick={() => {
          submit({ status: "manual", url: candidate.url });
        }}
        data-testid={`pairing-review-panel-pick-${productKey}-${String(index)}`}
      >
        Vybrať
      </button>
    </div>
  );
}
