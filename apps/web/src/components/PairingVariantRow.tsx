import type { JSX } from "react";
import type { PairingItem } from "../pairingApi.js";

const STATE_LABELS: Record<PairingItem["state"], string> = {
  navrhnute: "Navrhnuté",
  potvrdene: "Potvrdené",
};

/**
 * Presne JEDEN riadok tabuľky pre JEDEN variant (veľkosť) — vyňaté z
 * `PairingSection.tsx` bezo zmeny správania/testid-ov (issue 47, F4
 * rozdelenie podľa veľkostí), aby sa dal použiť na DVOCH miestach: pre
 * jednovariantné produkty (nezmenené, ako pred touto zmenou) AJ pre
 * "rozdelený" pohľad viacvariantného produktu (`PairingGroupRow.tsx` mu
 * predchádza len hlavičkovým riadkom produktu).
 */
export function PairingVariantRow({
  item,
  canConfirm,
  editingCode,
  urlDraft,
  busyCode,
  onUrlDraftChange,
  onStartEdit,
  onCancelEdit,
  onSaveManualUrl,
  onConfirmAsIs,
}: {
  readonly item: PairingItem;
  readonly canConfirm: boolean;
  readonly editingCode: string | null;
  readonly urlDraft: string;
  readonly busyCode: string | null;
  readonly onUrlDraftChange: (value: string) => void;
  readonly onStartEdit: (item: PairingItem) => void;
  readonly onCancelEdit: () => void;
  readonly onSaveManualUrl: (variantCode: string) => void;
  readonly onConfirmAsIs: (item: PairingItem) => void;
}): JSX.Element {
  const isEditing = editingCode === item.variantCode;
  const isBusy = busyCode === item.variantCode;

  return (
    <tr data-testid={`pairing-${item.variantCode}`}>
      <td>{item.variantCode}</td>
      <td>{item.variantName}</td>
      <td>{item.sizeLabel ?? "—"}</td>
      <td>{item.productSupplier ?? "—"}</td>
      <td>
        {isEditing ? (
          <>
            <input
              aria-label={`Adresa u dodávateľa pre ${item.variantCode}`}
              type="url"
              value={urlDraft}
              disabled={isBusy}
              onChange={(e) => {
                onUrlDraftChange(e.target.value);
              }}
            />
            <button
              type="button"
              disabled={isBusy || urlDraft.trim() === ""}
              onClick={() => {
                onSaveManualUrl(item.variantCode);
              }}
            >
              Potvrdiť
            </button>
            <button type="button" disabled={isBusy} onClick={onCancelEdit}>
              Zrušiť
            </button>
          </>
        ) : item.supplierUrl === null ? (
          "—"
        ) : (
          <a href={item.supplierUrl} target="_blank" rel="noreferrer">
            {item.supplierUrl}
          </a>
        )}
      </td>
      <td>{STATE_LABELS[item.state]}</td>
      <td>
        {item.confirmedByName === null
          ? "—"
          : `${item.confirmedByName} (${new Date(item.confirmedAt ?? "").toLocaleDateString("sk-SK")})`}
      </td>
      {canConfirm && (
        <td>
          {!isEditing && (
            <>
              <button
                type="button"
                data-testid={`confirm-${item.variantCode}`}
                // Už potvrdený riadok (state "potvrdene") sa opravuje len cez
                // "✗ Zadať inú adresu" — server berie opätovné potvrdenie ako
                // no-op a zachová PÔVODNÉHO potvrdzujúceho (issue 45).
                disabled={item.supplierUrl === null || item.state === "potvrdene" || isBusy}
                onClick={() => {
                  onConfirmAsIs(item);
                }}
              >
                ✓ Potvrdiť
              </button>
              <button
                type="button"
                data-testid={`reject-${item.variantCode}`}
                disabled={isBusy}
                onClick={() => {
                  onStartEdit(item);
                }}
              >
                ✗ Zadať inú adresu
              </button>
            </>
          )}
        </td>
      )}
    </tr>
  );
}
