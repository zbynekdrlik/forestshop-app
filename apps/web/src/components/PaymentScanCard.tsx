import { useCallback, useState, type JSX } from "react";
import { deletePaymentScan, PAYMENT_SCAN_DESCRIPTION_MAX_CHARS, updatePaymentScanDescription, uhradyScanImageUrl, type PaymentScanRow } from "../uhradyApi.js";

// issue 543: jedna dlaždica naskenovanej FA v gride (thumbnail + popis + mazanie
// s potvrdením). Popis je VŽDY viditeľné pole s LOKÁLNYM draftom
// inicializovaným raz z propu (`useState` initializer) — komponent je keyovaný
// `scan.id`, takže sa pri refetchi zoznamu NEremountuje a draft prežije (žiadny
// prop-syncing `useEffect`, teda ani „skip-first-mount"/dirty guard netreba —
// `.claude/rules/frontend-design.md` #121: toggled/lokálne seedovaný draft ho
// nepotrebuje). Uloženie popisu je optimistické (parent aktualizuje riadok v
// stave), takže neskorší refetch nesie správnu hodnotu.

interface Props {
  readonly scan: PaymentScanRow;
  readonly onOpenLightbox: (scan: PaymentScanRow) => void;
  readonly onDescriptionSaved: (id: string, description: string) => void;
  readonly onDeleted: (id: string) => void;
  readonly onError: (err: unknown, fallback: string) => void;
}

export function PaymentScanCard({ scan, onOpenLightbox, onDescriptionSaved, onDeleted, onError }: Props): JSX.Element {
  const [desc, setDesc] = useState(scan.description);
  const [savingDesc, setSavingDesc] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const saveDescription = useCallback(() => {
    const trimmed = desc.trim();
    if (trimmed === scan.description || savingDesc) return;
    setSavingDesc(true);
    updatePaymentScanDescription(scan.id, trimmed)
      .then(() => {
        onDescriptionSaved(scan.id, trimmed);
      })
      .catch((err: unknown) => {
        onError(err, "Popis sa nepodarilo uložiť — skúste to znova.");
      })
      .finally(() => {
        setSavingDesc(false);
      });
  }, [desc, scan.id, scan.description, savingDesc, onDescriptionSaved, onError]);

  const remove = useCallback(() => {
    setDeleting(true);
    deletePaymentScan(scan.id)
      .then(() => {
        onDeleted(scan.id);
      })
      .catch((err: unknown) => {
        onError(err, "Sken sa nepodarilo odstrániť — skúste to znova.");
        setDeleting(false);
        setConfirming(false);
      });
  }, [scan.id, onDeleted, onError]);

  return (
    <div className="uhrady-scan-card" data-testid={`uhrady-scan-${scan.id}`}>
      <button
        type="button"
        className="uhrady-thumb-btn"
        onClick={() => {
          onOpenLightbox(scan);
        }}
        title="Zväčšiť"
        aria-label={`Zväčšiť sken${scan.description === "" ? "" : ` ${scan.description}`}`}
        data-testid={`uhrady-thumb-${scan.id}`}
      >
        <img className="uhrady-thumb-img" src={uhradyScanImageUrl(scan.id)} loading="lazy" alt={scan.description === "" ? "Naskenovaná faktúra" : scan.description} />
      </button>

      <input
        type="text"
        className="uhrady-desc-input"
        value={desc}
        maxLength={PAYMENT_SCAN_DESCRIPTION_MAX_CHARS}
        onChange={(e) => {
          setDesc(e.target.value);
        }}
        onBlur={saveDescription}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Popis…"
        aria-label={`Popis skenu`}
        disabled={deleting}
        data-testid={`uhrady-desc-${scan.id}`}
      />

      {confirming ? (
        <div className="uhrady-confirm" data-testid={`uhrady-confirm-${scan.id}`}>
          <span className="uhrady-confirm-q">Zmazať?</span>
          <button type="button" className="btn bad" onClick={remove} disabled={deleting} data-testid={`uhrady-confirm-yes-${scan.id}`}>
            Áno, zmazať
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setConfirming(false);
            }}
            disabled={deleting}
            data-testid={`uhrady-confirm-no-${scan.id}`}
          >
            Zrušiť
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="uhrady-scan-delete"
          onClick={() => {
            setConfirming(true);
          }}
          title="Odstrániť sken (po úhrade)"
          aria-label={`Odstrániť sken${scan.description === "" ? "" : ` ${scan.description}`}`}
          data-testid={`uhrady-delete-${scan.id}`}
        >
          🗑 Zmazať
        </button>
      )}
    </div>
  );
}
