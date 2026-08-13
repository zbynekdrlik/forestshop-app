import type { JSX } from "react";
import type { LiveSupplierInfo, PairingDecisionAction, PairingReviewCandidate } from "../pairingReviewApi.js";
import { useLiveSupplierInfo } from "../useLiveSupplierInfo.js";

// issue 398/409/422 — vyčlenené z `PairingReviewCard.tsx` (eslint `max-lines: 400`,
// `.claude/rules/frontend-design.md`'s zavedený vzor "component file that grows
// past the cap gets its repeated per-item rendering unit extracted"). Malé,
// bezstavové zložky zdieľané s `PairingReviewCard.tsx`:
// `TerminalButtons` (priamy riadok na karte AJ panel — vzájomne vylučujúce v
// DOM-e, zdieľajú testid), `PanelCandidateRow` (jeden riadok top-8 zoznamu v
// rozbaľovacom paneli, s obrázkom kandidáta — issue 409 — a živou cenou/
// dostupnosťou — issue 422) a `ChosenCandidateExtras` (🤖 AI zdôvodnenie +
// živá cena/dostupnosť navrhnutého kandidáta na karte, issue 422).

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

// issue 422 — 🤖 AI zdôvodnenie zhody + živá cena/dostupnosť dodávateľa pre
// navrhnutého kandidáta na karte. Vyčlenené (nie priamo v `PairingReviewCard
// .tsx`) len kvôli `max-lines: 400` — `liveInfo` je hook výsledok z rodiča
// (`useLiveSupplierInfo` sa volá LEN RAZ na kartu, nie tu znova), táto zložka
// je čisto presentational. `chosenReason` je LEN vedľa navrhnutého kandidáta
// (rovnaká podmienka ako stará appka's `showReason && ai_status ===
// 'matched'`) — nikdy pre nenapárované produkty (`chosenReason` je preň
// štrukturálne vždy `null`, design komentár na tickete #422).
export function ChosenCandidateExtras({
  productKey,
  chosenReason,
  liveInfo,
}: {
  readonly productKey: string;
  readonly chosenReason: string | null;
  readonly liveInfo: LiveSupplierInfo;
}): JSX.Element {
  return (
    <>
      {chosenReason !== null && (
        <div className="pairing-review-reason" data-testid={`pairing-review-reason-${productKey}`}>
          🤖 {chosenReason}
        </div>
      )}
      {(liveInfo.price !== null || liveInfo.availabilityText !== null) && (
        <div className="pairing-review-supplier-live" data-testid={`pairing-review-live-info-${productKey}`}>
          {liveInfo.price !== null && <>💶 {liveInfo.price} €</>}
          {liveInfo.price !== null && liveInfo.availabilityText !== null && " · "}
          {liveInfo.availabilityText}
        </div>
      )}
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
  // issue 422 — každý riadok panelu je NEZÁVISLE mountnutý (rovnaký zámer
  // ako karta) — `useLiveSupplierInfo`'s modul-level concurrency fronta
  // chráni pred burstom, keď sa panel s top-8 kandidátmi otvorí naraz.
  const liveInfo = useLiveSupplierInfo(candidate.url);
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
        <span>
          {candidate.name}: {candidate.url}
          {candidate.codeHit && " (kód sedí)"}
        </span>
        {(liveInfo.price !== null || liveInfo.availabilityText !== null) && (
          <div className="pairing-review-panel-candidate-live" data-testid={`pairing-review-panel-live-info-${productKey}-${String(index)}`}>
            {liveInfo.price !== null && <>💶 {liveInfo.price} €</>}
            {liveInfo.price !== null && liveInfo.availabilityText !== null && " · "}
            {liveInfo.availabilityText}
          </div>
        )}
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
