import { useCallback, useEffect, useState, type JSX } from "react";
import { useStaleResponseGuard } from "../useStaleResponseGuard.js";
import {
  fetchPairingVariantLinks,
  PairingReviewUnauthorizedError,
  savePairingVariantLink,
  type PairingDecisionAction,
  type PairingReviewCandidate,
  type PairingReviewItem,
  type PairingVariantLink,
} from "../pairingReviewApi.js";
import { validateSupplierLinkUrl } from "../ordersApi.js";

// issue 399 — "✂ Rozdeliť na veľkosti": port starej appky's `splitPanel`/
// `splitRow` (`parovanie_produktov` @ f76cafa, `webreview/static/app.js:254-
// 341`) — per-veľkosť editor, otvorený z `PairingReviewCard.tsx` (trigger +
// `decision.status === "split"` obe volajú TENTO panel, presne ako stará
// appka "while open OR committed"). Vlastný, NEZÁVISLÝ zápis
// (`POST .../variant-link`, `variant-links.ts`) — každý riadok sa uloží
// SAMOSTATNE, hneď pri kliku "Uložiť", nie hromadne s "✓ Hotovo – rozdelené".
// `candidates`/`candidatesError` sú PREVZATÉ z rodiča (`PairingReviewCard.tsx`'s
// už existujúci `loadCandidates()`) — žiadny druhý fetch tých istých top-8
// kandidátov, len znovupoužité ako quick-pick tlačidlá per riadok (rovnaký
// zdroj dát, aký stará appka's `p.candidates` použila).
//
// Design komentár (root cause/prístup/zamietnutá alternatíva/Architektúra)
// pre #399: https://github.com/zbynekdrlik/forestshop-app/issues/399

function VariantRow({
  productKey,
  variant,
  candidates,
  busy,
  onSaved,
  onBusyChange,
}: {
  readonly productKey: string;
  readonly variant: PairingVariantLink;
  readonly candidates: readonly PairingReviewCandidate[] | null;
  readonly busy: boolean;
  readonly onSaved: (code: string, url: string | null) => void;
  readonly onBusyChange: (code: string, busy: boolean) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(variant.url ?? "");
  const [rowBusy, setRowBusy] = useState(false);
  const [rowError, setRowError] = useState("");
  const label = variant.sizeLabel ?? variant.code;

  const save = useCallback(
    (url: string) => {
      const trimmed = url.trim();
      if (trimmed !== "") {
        const validationError = validateSupplierLinkUrl(trimmed);
        if (validationError !== null) {
          setRowError(validationError);
          return;
        }
      }
      setRowError("");
      setRowBusy(true);
      onBusyChange(variant.code, true);
      savePairingVariantLink(productKey, variant.code, trimmed === "" ? null : trimmed)
        .then(() => {
          onSaved(variant.code, trimmed === "" ? null : trimmed);
        })
        .catch((err: unknown) => {
          setRowError(err instanceof Error ? err.message : "Uloženie sa nepodarilo.");
        })
        .finally(() => {
          setRowBusy(false);
          onBusyChange(variant.code, false);
        });
    },
    [productKey, variant.code, onSaved, onBusyChange],
  );

  const disabled = busy || rowBusy;

  return (
    <div className="pairing-review-split-row" data-testid={`pairing-review-split-row-${variant.code}`}>
      <div className="pairing-review-split-row-head">
        <span className="pairing-review-split-size">{label}</span>
        {variant.sizeLabel !== null && <span className="pairing-review-split-code">{variant.code}</span>}
        <span
          className={"pairing-review-split-state" + (variant.url !== null ? " has" : "")}
          data-testid={`pairing-review-split-state-${variant.code}`}
        >
          {variant.url !== null ? "✓ link nastavený" : "bez linku"}
        </span>
      </div>

      {candidates !== null && candidates.length > 0 && (
        <div className="pairing-review-split-candidates">
          {candidates.map((c) => (
            <button
              key={c.url}
              type="button"
              className="btn ghost sm"
              disabled={disabled}
              onClick={() => {
                setDraft(c.url);
                save(c.url);
              }}
            >
              Vybrať: {c.name}
            </button>
          ))}
        </div>
      )}

      {rowError !== "" && <p role="alert">{rowError}</p>}
      <div className="pairing-review-split-manual">
        <input
          type="url"
          placeholder={`Link dodávateľa pre veľkosť ${label}…`}
          value={draft}
          disabled={disabled}
          data-testid={`pairing-review-split-input-${variant.code}`}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
        />
        <button
          type="button"
          className="btn good sm"
          disabled={disabled}
          onClick={() => {
            save(draft);
          }}
          data-testid={`pairing-review-split-save-${variant.code}`}
        >
          Uložiť
        </button>
      </div>
    </div>
  );
}

export function PairingReviewSplitPanel({
  item,
  busy,
  submit,
  candidates,
  candidatesError,
  onSessionExpired,
}: {
  readonly item: PairingReviewItem;
  readonly busy: boolean;
  readonly submit: (action: PairingDecisionAction) => void;
  readonly candidates: readonly PairingReviewCandidate[] | null;
  readonly candidatesError: string;
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [variants, setVariants] = useState<readonly PairingVariantLink[] | null>(null);
  const [variantsError, setVariantsError] = useState("");
  const [busyRowCodes, setBusyRowCodes] = useState<ReadonlySet<string>>(new Set());
  const guard = useStaleResponseGuard();

  useEffect(() => {
    const seq = guard.begin();
    fetchPairingVariantLinks(item.productKey)
      .then((result) => {
        if (!guard.isLatest(seq)) return;
        setVariants(result);
      })
      .catch((err: unknown) => {
        if (!guard.isLatest(seq)) return;
        if (err instanceof PairingReviewUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setVariantsError("Zoznam veľkostí sa nepodarilo načítať.");
      });
    // `item.productKey` je stabilné pre celú životnosť karty (karty sú
    // kľúčované `productKey`, `PairingReviewSection.tsx`) — netreba
    // `onSessionExpired` do závislostí (stabilná funkcia z `App.tsx`,
    // rovnaký vzor ako `PairingReviewCard.tsx`'s `loadCandidates`).
  }, [item.productKey]);

  const onVariantSaved = useCallback((code: string, url: string | null) => {
    setVariants((prev) => (prev === null ? prev : prev.map((v) => (v.code === code ? { ...v, url } : v))));
  }, []);

  // issue 399 (review finding, #423 self-review) — "✓ Hotovo" nesmie ísť
  // odoslať, kým NIEKTORÝ riadok ešte čaká na svoj VLASTNÝ zápis (`save()`
  // vyššie) — bez tohto by klik mohol vidieť `variants`'ov ešte-nezapísaný
  // (starý) stav a zbytočne (konzervatívne) ukázať varovací dialóg o
  // chýbajúcom linku, hoci zápis, čo je práve v letu, ho o pár ms doplní.
  const onRowBusyChange = useCallback((code: string, rowBusy: boolean) => {
    setBusyRowCodes((prev) => {
      const has = prev.has(code);
      if (rowBusy === has) return prev;
      const next = new Set(prev);
      if (rowBusy) next.add(code);
      else next.delete(code);
      return next;
    });
  }, []);

  const isSplit = item.decision?.status === "split";
  const missingCount = variants?.filter((v) => v.url === null).length ?? 0;
  const anyRowBusy = busyRowCodes.size > 0;

  return (
    <div className="pairing-review-split-panel" data-testid={`pairing-review-split-panel-${item.productKey}`}>
      <p className="pairing-review-split-hint">Dodávateľ má inú stránku pre každú veľkosť? Nastav vlastný link pre KAŽDÚ veľkosť.</p>
      {variantsError !== "" && <p role="alert">{variantsError}</p>}
      {variants === null && variantsError === "" && <p>Načítavam veľkosti…</p>}
      {variants !== null &&
        variants.map((v) => <VariantRow key={v.code} productKey={item.productKey} variant={v} candidates={candidates} busy={busy} onSaved={onVariantSaved} onBusyChange={onRowBusyChange} />)}
      {candidatesError !== "" && <p role="alert">{candidatesError}</p>}

      <div className="pairing-review-split-foot">
        {isSplit ? (
          <button
            type="button"
            className="btn ghost sm"
            disabled={busy}
            onClick={() => {
              submit({ status: "revert" });
            }}
            data-testid={`pairing-review-split-cancel-${item.productKey}`}
          >
            ↩ Zrušiť rozdelenie
          </button>
        ) : (
          <button
            type="button"
            className="btn good sm"
            disabled={busy || variants === null || anyRowBusy}
            onClick={() => {
              // issue 399 (port starej appky's #180 varovanie) — veľkosť bez
              // vlastného linku ostane s pôvodným (produktovým) odkazom,
              // manažér o tom musí vedieť PRED uzavretím.
              if (missingCount > 0) {
                const veta = missingCount === 1 ? "Jedna veľkosť nemá vlastný link — ostane jej pôvodný link produktu." : `${String(missingCount)} veľkostí nemá vlastný link — ostanú im pôvodný link produktu.`;
                if (!window.confirm(`${veta} Pokračovať?`)) return;
              }
              submit({ status: "split" });
            }}
            data-testid={`pairing-review-split-done-${item.productKey}`}
          >
            ✓ Hotovo – rozdelené
          </button>
        )}
      </div>
    </div>
  );
}
