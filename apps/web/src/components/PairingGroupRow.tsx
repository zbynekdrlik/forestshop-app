import type { JSX } from "react";
import { formatSkDate } from "../formatDate.js";
import { groupConfirmation, isGroupFullyConfirmed, type ProductGroup } from "../pairingGroups.js";

const STATE_LABELS = { navrhnute: "Navrhnuté", potvrdene: "Potvrdené" } as const;

/**
 * ZBALENÝ riadok pre viacvariantný produkt, ktorého varianty majú (zatiaľ)
 * VŠETKY zhodnú adresu u dodávateľa (issue 47) — jedno pole na adresu,
 * akcie sa aplikujú na VŠETKY jeho veľkosti naraz. Vykresľuje sa LEN keď
 * `isGroupHomogeneous(group)` platí a manažér skupinu ručne neotvoril cez
 * "✂ Rozdeliť na veľkosti" (rozhoduje volajúci `PairingSection.tsx`).
 */
export function PairingGroupRow({
  group,
  canConfirm,
  editingGroupKey,
  groupUrlDraft,
  busyGroupKey,
  onGroupUrlDraftChange,
  onStartEditGroup,
  onCancelEditGroup,
  onSaveManualUrlForGroup,
  onConfirmGroupAsIs,
  onOpenSplit,
}: {
  readonly group: ProductGroup;
  readonly canConfirm: boolean;
  readonly editingGroupKey: string | null;
  readonly groupUrlDraft: string;
  readonly busyGroupKey: string | null;
  readonly onGroupUrlDraftChange: (value: string) => void;
  readonly onStartEditGroup: (group: ProductGroup) => void;
  readonly onCancelEditGroup: () => void;
  readonly onSaveManualUrlForGroup: (group: ProductGroup) => void;
  readonly onConfirmGroupAsIs: (group: ProductGroup) => void;
  readonly onOpenSplit: (productKey: string) => void;
}): JSX.Element {
  const isEditing = editingGroupKey === group.productKey;
  const isBusy = busyGroupKey === group.productKey;
  const representativeUrl = group.variants[0]?.supplierUrl ?? null;
  const productSupplier = group.variants[0]?.productSupplier ?? null;
  const sizes = group.variants.map((v) => v.sizeLabel ?? v.variantCode).join(", ");
  const confirmed = groupConfirmation(group);
  const fullyConfirmed = isGroupFullyConfirmed(group);

  return (
    <tr data-testid={`pairing-group-${group.productKey}`}>
      <td>—</td>
      <td>{group.productName}</td>
      <td>{sizes}</td>
      <td>{productSupplier ?? "—"}</td>
      <td>
        {isEditing ? (
          <>
            <input
              aria-label={`Adresa u dodávateľa pre ${group.productName} (všetky veľkosti)`}
              type="url"
              value={groupUrlDraft}
              disabled={isBusy}
              onChange={(e) => {
                onGroupUrlDraftChange(e.target.value);
              }}
            />
            <button
              type="button"
              disabled={isBusy || groupUrlDraft.trim() === ""}
              onClick={() => {
                onSaveManualUrlForGroup(group);
              }}
            >
              Potvrdiť
            </button>
            <button type="button" disabled={isBusy} onClick={onCancelEditGroup}>
              Zrušiť
            </button>
          </>
        ) : representativeUrl === null ? (
          "—"
        ) : (
          <a href={representativeUrl} target="_blank" rel="noreferrer">
            {representativeUrl}
          </a>
        )}
      </td>
      <td>{STATE_LABELS[fullyConfirmed ? "potvrdene" : "navrhnute"]}</td>
      <td>
        {confirmed.confirmedByName === null
          ? "—"
          : `${confirmed.confirmedByName} (${formatSkDate(confirmed.confirmedAt)})`}
      </td>
      {canConfirm && (
        <td>
          {!isEditing && (
            <>
              <button
                type="button"
                data-testid={`confirm-group-${group.productKey}`}
                disabled={representativeUrl === null || fullyConfirmed || isBusy}
                onClick={() => {
                  onConfirmGroupAsIs(group);
                }}
              >
                ✓ Potvrdiť
              </button>
              <button
                type="button"
                data-testid={`reject-group-${group.productKey}`}
                disabled={isBusy}
                onClick={() => {
                  onStartEditGroup(group);
                }}
              >
                ✗ Zadať inú adresu
              </button>
              <button
                type="button"
                data-testid={`split-${group.productKey}`}
                disabled={isBusy}
                title="Nastaviť inú adresu dodávateľa pre každú veľkosť zvlášť"
                onClick={() => {
                  onOpenSplit(group.productKey);
                }}
              >
                ✂ Rozdeliť na veľkosti
              </button>
            </>
          )}
        </td>
      )}
    </tr>
  );
}
