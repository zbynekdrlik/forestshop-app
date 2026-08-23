import { useCallback, useContext, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { autoResizeTextarea } from "../autoResizeTextarea.js";
import {
  attachFloorNoteProduct,
  createFloorNote,
  deleteFloorNote,
  detachFloorNoteProduct,
  fetchFloorNotes,
  FloorNotesUnauthorizedError,
  setFloorNoteCalled,
  setFloorNoteOrdered,
  setFloorNoteResolved,
  updateFloorNoteProductQuantity,
  updateFloorNoteText,
  type FloorNoteRow as FloorNoteRowData,
} from "../floorNotesApi.js";
import { FloorNotesBadgeRefreshContext } from "../floorNotesBadgeContext.js";
import type { ProductSearchHit } from "../searchApi.js";
import { FloorNoteRow } from "./FloorNoteRow.js";

// issue 410: "Eshop → Objednávky predajňa" — nahrádza Štěpánovo Discord
// vlákno vlastnými zápismi z predajne (design komentár na ticket-e). Táto
// obrazovka je VIDITEĽNÁ v `nav.ts` (`isVisibleTabId`) — NESMIE renderovať
// vlastný `<h1>/<h2>` s textom "Objednávky predajňa" (App.tsx/Topbar to už
// robí), rovnaký vzor ako `OrdersSection.tsx`/`NedostupneSection.tsx`.
const CAN_EDIT_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

const MARKER_LABELS: Record<"resolved" | "ordered" | "called", string> = {
  resolved: "Vybavené",
  ordered: "Objednané",
  called: "Zavolané",
};

export function FloorNotesSection({ role, onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  const [rows, setRows] = useState<readonly FloorNoteRowData[] | null>(null);
  const [error, setError] = useState("");
  const [newText, setNewText] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState("");
  const canEdit = CAN_EDIT_ROLES.has(role);

  // issue 473: odznak počtu nevybavených zápisov v ľavom menu (`App.tsx` ho
  // vlastní/fetchuje) — po count-meniacej mutácii zavolá `refresh()`, aby číslo
  // kleslo/stúplo hneď bez reloadu. Count MENÍ len: pridanie, zmazanie a
  // prepnutie ✅ vybavené (`resolved`). Značky 🛒 objednané / 📞 zavolané count
  // NEMENIA, tie refresh nevolajú (design komentár na issue 473).
  const { refresh: badgeRefresh } = useContext(FloorNotesBadgeRefreshContext);

  const load = useCallback(() => {
    fetchFloorNotes()
      .then((data) => {
        setRows(data);
      })
      .catch((err: unknown) => {
        if (err instanceof FloorNotesUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Zoznam zápisov sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(() => {
    load();
  }, [load]);

  const handleActionError = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof FloorNotesUnauthorizedError) {
        onSessionExpired();
        return;
      }
      setError(err instanceof Error ? err.message : fallback);
    },
    [onSessionExpired],
  );

  const addNote = useCallback(() => {
    const text = newText.trim();
    if (text === "" || creating) return;
    setCreating(true);
    setError("");
    createFloorNote(text)
      .then(() => {
        setNewText("");
        load();
        badgeRefresh();
      })
      .catch((err: unknown) => {
        handleActionError(err, "Zápis sa nepodarilo pridať — skúste to znova.");
      })
      .finally(() => {
        setCreating(false);
      });
  }, [newText, creating, load, handleActionError, badgeRefresh]);

  const saveText = useCallback(
    (id: string, text: string) => {
      setBusyId(id);
      setError("");
      updateFloorNoteText(id, text)
        .then(() => {
          load();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Text sa nepodarilo uložiť — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError],
  );

  const toggleMarker = useCallback(
    (id: string, marker: "resolved" | "ordered" | "called", value: boolean) => {
      setBusyId(id);
      setError("");
      const setter = marker === "resolved" ? setFloorNoteResolved : marker === "ordered" ? setFloorNoteOrdered : setFloorNoteCalled;
      setter(id, value)
        .then(() => {
          load();
          // LEN ✅ vybavené (`resolved`) mení počet nevybavených zápisov —
          // 🛒 objednané / 📞 zavolané sú nezávislé značky bez vplyvu na odznak.
          if (marker === "resolved") badgeRefresh();
        })
        .catch((err: unknown) => {
          handleActionError(err, `${MARKER_LABELS[marker]} — akcia zlyhala, skúste to znova.`);
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError, badgeRefresh],
  );

  const removeNote = useCallback(
    (id: string) => {
      setBusyId(id);
      setError("");
      deleteFloorNote(id)
        .then(() => {
          load();
          badgeRefresh();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Zápis sa nepodarilo odstrániť — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError, badgeRefresh],
  );

  const attachProduct = useCallback(
    (id: string, hit: ProductSearchHit, quantity: number) => {
      setBusyId(id);
      setError("");
      attachFloorNoteProduct(id, hit.variantCode, quantity)
        .then(() => {
          load();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Produkt sa nepodarilo pripnúť — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError],
  );

  // issue 453: dodatočná úprava počtu kusov už pripnutého produktu.
  const updateProductQuantity = useCallback(
    (id: string, variantCode: string, quantity: number) => {
      setBusyId(id);
      setError("");
      updateFloorNoteProductQuantity(id, variantCode, quantity)
        .then(() => {
          load();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Počet kusov sa nepodarilo upraviť — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError],
  );

  const detachProduct = useCallback(
    (id: string, variantCode: string) => {
      setBusyId(id);
      setError("");
      detachFloorNoteProduct(id, variantCode)
        .then(() => {
          load();
        })
        .catch((err: unknown) => {
          handleActionError(err, "Produkt sa nepodarilo odopnúť — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, handleActionError],
  );

  const intro = (
    <p>
      Zápisy vytvorené priamo na predajni — nahrádza Discordovo vlákno. Voľný text (adresa, kontakt,
      čokoľvek), pripnuté produkty a tri značky ✅ vybavené / 🛒 objednané / 📞 zavolané bez ďalšej funkcie.
    </p>
  );

  const addRow = canEdit && (
    <div className="floor-note-add-row">
      <textarea
        value={newText}
        onChange={(e) => {
          setNewText(e.target.value);
          autoResizeTextarea(e.target);
        }}
        aria-label="Nový zápis"
        placeholder="Meno, telefón, adresa, čo si zákazník praje…"
        data-testid="floor-note-new-input"
        disabled={creating}
      />
      <div className="form-actions">
        <button type="button" className="btn good sm" onClick={addNote} disabled={newText.trim() === "" || creating} data-testid="floor-note-new-add">
          + Pridať zápis
        </button>
      </div>
    </div>
  );

  if (rows === null) {
    return (
      <section>
        {intro}
        <div className="floor-notes-panel">
          {addRow}
          {error !== "" ? <p role="alert">{error}</p> : <p>Načítavam…</p>}
        </div>
      </section>
    );
  }

  return (
    <section>
      {intro}
      <div className="floor-notes-panel">
        {addRow}
        {error !== "" && <p role="alert">{error}</p>}

        {rows.length === 0 ? (
          <p data-testid="floor-notes-empty">Zatiaľ žiadne zápisy.</p>
        ) : (
          <div className="floor-notes-list" data-testid="floor-notes-list">
            {rows.map((row) => (
              <FloorNoteRow
                key={row.id}
                row={row}
                busy={busyId === row.id}
                canEdit={canEdit}
                onSaveText={(text) => {
                  saveText(row.id, text);
                }}
                onToggleMarker={(marker, value) => {
                  toggleMarker(row.id, marker, value);
                }}
                onDelete={() => {
                  removeNote(row.id);
                }}
                onAttachProduct={(hit, quantity) => {
                  attachProduct(row.id, hit, quantity);
                }}
                onDetachProduct={(variantCode) => {
                  detachProduct(row.id, variantCode);
                }}
                onUpdateQuantity={(variantCode, quantity) => {
                  updateProductQuantity(row.id, variantCode, quantity);
                }}
                onSessionExpired={onSessionExpired}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
