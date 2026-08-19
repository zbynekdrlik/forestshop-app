import { useState, type JSX } from "react";
import { autoResizeTextarea } from "../autoResizeTextarea.js";
import { formatSkDateTime } from "../formatDate.js";
import type { ProductSearchHit } from "../searchApi.js";
import type { FloorNoteRow as FloorNoteRowData } from "../floorNotesApi.js";
import { FloorNoteProductChip } from "./FloorNoteProductChip.js";
import { FloorNoteProductSearch } from "./FloorNoteProductSearch.js";

// issue 410: jeden zápis "Eshop → Objednávky predajňa" — voľný text (rastúca
// textarea, žiadne odoslanie Enterom, `autoResizeTextarea.ts`), tri
// nezávislé značky (✅ vybavené/🛒 objednané/📞 zavolané, žiadna ďalšia
// funkcia, presne ako Discord reakcie na ticket-e), 0..N pripnutých
// produktov (klikateľné → detail na www.forestshop.sk, `shopLinks.ts`'s
// `ourProductLink` — vizuálne odlíšený náhradný odkaz, keď priama adresa nie
// je známa, presne ako `PairingReviewCard.tsx` po issue 402).
export function FloorNoteRow({
  row,
  busy,
  canEdit,
  onSaveText,
  onToggleMarker,
  onDelete,
  onAttachProduct,
  onDetachProduct,
  onUpdateQuantity,
  onSessionExpired,
}: {
  readonly row: FloorNoteRowData;
  readonly busy: boolean;
  // issue 410: rovnaký vzor ako `UpozorneniaSection.tsx`'s `CONTROL_ROLES` —
  // zápis je gejtovaný `requireRole("admin","manazer")` na serveri
  // (`floor-notes-routes.ts`), UI preto pre "citanie" rolu skrýva/vypne
  // KAŽDÝ interaktívny prvok (značky, upraviť, zmazať, pripnúť/odopnúť
  // produkt) — čítanie zoznamu ostáva viditeľné pre všetkých.
  readonly canEdit: boolean;
  readonly onSaveText: (text: string) => void;
  readonly onToggleMarker: (marker: "resolved" | "ordered" | "called", value: boolean) => void;
  readonly onDelete: () => void;
  readonly onAttachProduct: (hit: ProductSearchHit, quantity: number) => void;
  readonly onDetachProduct: (variantCode: string) => void;
  // issue 453: úprava počtu kusov už pripnutého produktu.
  readonly onUpdateQuantity: (variantCode: string, quantity: number) => void;
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [editingText, setEditingText] = useState(false);
  const [textDraft, setTextDraft] = useState(row.text);
  const [searchOpen, setSearchOpen] = useState(false);

  const attached = new Set(row.products.map((p) => p.variantCode));

  const startEdit = (): void => {
    setTextDraft(row.text);
    setEditingText(true);
  };
  const saveEdit = (): void => {
    const trimmed = textDraft.trim();
    if (trimmed === "") return;
    onSaveText(trimmed);
    setEditingText(false);
  };

  return (
    <div className={"card floor-note-card" + (row.resolved ? " floor-note-resolved" : "")} data-testid={`floor-note-row-${row.id}`}>
      <div className="floor-note-head">
        <div className="floor-note-markers">
          <button
            type="button"
            className={"floor-note-marker" + (row.resolved ? " active" : "")}
            aria-pressed={row.resolved}
            title="Vybavené"
            aria-label={`Vybavené — zápis ${row.id}`}
            disabled={busy || !canEdit}
            onClick={() => {
              onToggleMarker("resolved", !row.resolved);
            }}
            data-testid={`floor-note-marker-resolved-${row.id}`}
          >
            ✅
          </button>
          <button
            type="button"
            className={"floor-note-marker" + (row.ordered ? " active" : "")}
            aria-pressed={row.ordered}
            title="Objednané"
            aria-label={`Objednané — zápis ${row.id}`}
            disabled={busy || !canEdit}
            onClick={() => {
              onToggleMarker("ordered", !row.ordered);
            }}
            data-testid={`floor-note-marker-ordered-${row.id}`}
          >
            🛒
          </button>
          <button
            type="button"
            className={"floor-note-marker" + (row.called ? " active" : "")}
            aria-pressed={row.called}
            title="Zavolané"
            aria-label={`Zavolané — zápis ${row.id}`}
            disabled={busy || !canEdit}
            onClick={() => {
              onToggleMarker("called", !row.called);
            }}
            data-testid={`floor-note-marker-called-${row.id}`}
          >
            📞
          </button>
        </div>
        <span className="floor-note-time">{formatSkDateTime(row.createdAt)}</span>
        {canEdit && (
          <button
            type="button"
            className="floor-note-icon-btn"
            disabled={busy}
            onClick={onDelete}
            title="Odstrániť"
            aria-label={`Odstrániť zápis ${row.id}`}
            data-testid={`floor-note-delete-${row.id}`}
          >
            🗑
          </button>
        )}
      </div>

      {editingText && canEdit ? (
        <div className="floor-note-edit">
          <textarea
            className="floor-note-textarea"
            value={textDraft}
            autoFocus
            onChange={(e) => {
              setTextDraft(e.target.value);
              autoResizeTextarea(e.target);
            }}
            aria-label={`Upraviť text zápisu ${row.id}`}
            data-testid={`floor-note-edit-input-${row.id}`}
          />
          <div className="form-actions">
            <button type="button" className="btn sm good" disabled={busy || textDraft.trim() === ""} onClick={saveEdit} data-testid={`floor-note-edit-save-${row.id}`}>
              💾 Uložiť
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() => {
                setEditingText(false);
              }}
              data-testid={`floor-note-edit-cancel-${row.id}`}
            >
              ✖ Zrušiť
            </button>
          </div>
        </div>
      ) : (
        <div className="floor-note-text-row">
          <p className="floor-note-text" data-testid={`floor-note-text-${row.id}`}>
            {row.text}
          </p>
          {canEdit && (
            <button
              type="button"
              className="floor-note-icon-btn"
              disabled={busy}
              onClick={startEdit}
              title="Upraviť text"
              aria-label={`Upraviť text zápisu ${row.id}`}
              data-testid={`floor-note-edit-${row.id}`}
            >
              ✏️
            </button>
          )}
        </div>
      )}

      {row.products.length > 0 && (
        <div className="floor-note-products" data-testid={`floor-note-products-${row.id}`}>
          {row.products.map((p) => (
            <FloorNoteProductChip
              key={p.variantCode}
              product={p}
              noteId={row.id}
              busy={busy}
              canEdit={canEdit}
              onDetach={() => {
                onDetachProduct(p.variantCode);
              }}
              onUpdateQuantity={(quantity) => {
                onUpdateQuantity(p.variantCode, quantity);
              }}
            />
          ))}
        </div>
      )}

      {canEdit && (
        <>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            onClick={() => {
              setSearchOpen((open) => !open);
            }}
            data-testid={`floor-note-attach-toggle-${row.id}`}
          >
            {searchOpen ? "✖ Zavrieť hľadanie" : "+ Pripnúť produkt"}
          </button>

          {searchOpen && (
            <FloorNoteProductSearch
              alreadyAttached={attached}
              attaching={busy}
              onAttach={(hit, quantity) => {
                onAttachProduct(hit, quantity);
              }}
              onSessionExpired={onSessionExpired}
            />
          )}
        </>
      )}
    </div>
  );
}
