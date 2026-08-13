import type { JSX } from "react";
import type { PairingDecisionAction, PairingReviewCandidate } from "../pairingReviewApi.js";
import { PanelCandidateRow, TerminalButtons } from "./PairingReviewPanelParts.js";

// issue 399 — vyčlenené z `PairingReviewCard.tsx` (eslint `max-lines: 400`,
// `.claude/rules/frontend-design.md`'s zavedený vzor "component file that
// grows past the cap gets its repeated/self-contained rendering unit
// extracted") — pridanie "✂ Rozdeliť na veľkosti" (`PairingReviewSplitPanel.tsx`)
// posunulo súbor cez limit. Čisto presentational: VŠETOK stav (`candidates`/
// `manualUrl`/`busy`/`panelOpen`) ostáva vlastníctvom `PairingReviewCard.tsx`,
// tento komponent len vykresľuje panel "vyber url"/kandidáti/manuál/terminálne
// tlačidlá/Zavrieť — presne ten istý JSX blok, čo tu bol predtým priamo.

export function PairingReviewDecisionPanel({
  productKey,
  busy,
  candidatesError,
  candidates,
  manualUrl,
  onManualUrlChange,
  onSaveManual,
  submit,
  panelOpen,
  onClose,
}: {
  readonly productKey: string;
  readonly busy: boolean;
  readonly candidatesError: string;
  readonly candidates: readonly PairingReviewCandidate[] | null;
  readonly manualUrl: string;
  readonly onManualUrlChange: (value: string) => void;
  readonly onSaveManual: () => void;
  readonly submit: (action: PairingDecisionAction) => void;
  readonly panelOpen: boolean;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div className="pairing-review-panel" data-testid={`pairing-review-panel-${productKey}`}>
      {candidatesError !== "" && <p role="alert">{candidatesError}</p>}
      {candidates === null && candidatesError === "" && <p>Načítavam kandidátov…</p>}
      {candidates !== null && candidates.map((c, i) => <PanelCandidateRow key={c.url} candidate={c} index={i} busy={busy} submit={submit} productKey={productKey} />)}

      <div className="pairing-review-manual-row">
        <input
          type="url"
          placeholder="Vlož vlastnú URL dodávateľa…"
          value={manualUrl}
          disabled={busy}
          data-testid={`pairing-review-manual-input-${productKey}`}
          onChange={(e) => {
            onManualUrlChange(e.target.value);
          }}
        />
        <button type="button" className="btn good sm" disabled={busy || manualUrl.trim() === ""} onClick={onSaveManual} data-testid={`pairing-review-manual-save-${productKey}`}>
          Uložiť URL
        </button>
      </div>

      <div className="pairing-review-terminal-row">
        <TerminalButtons busy={busy} submit={submit} productKey={productKey} />
      </div>

      {panelOpen && (
        <button type="button" className="btn ghost sm" disabled={busy} onClick={onClose} data-testid={`pairing-review-panel-cancel-${productKey}`}>
          Zavrieť
        </button>
      )}
    </div>
  );
}
