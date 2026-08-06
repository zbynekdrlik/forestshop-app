import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { formatSkDateTime } from "../formatDate.js";
import { fetchResolvedUpozornenia, returnUpozornenieToOpen, UpozorneniaUnauthorizedError, type ResolvedUpozornenieRow } from "../upozorneniaApi.js";

// issue 283 (majiteľ, komentár na tickete): záložka "Vybavené" na nástenke
// Upozornenia — história vyriešených kariet + tlačidlo na vrátenie späť medzi
// otvorené. Vyčlenené do VLASTNÉHO komponentu, aby `UpozorneniaSection.tsx`
// (už 432 riadkov) neprerástol cez eslint `max-lines: 400`
// (`.claude/rules/frontend-design.md`'s zavedený vzor pre rastúce súbory).
const RESOLVED_LIST_LIMIT = 200;

const TYPE_LABELS: Readonly<Record<ResolvedUpozornenieRow["type"], string>> = {
  vlastna_poznamka: "Moja poznámka",
  nevyzdvihnuta_zasielka: "Nevyzdvihnutá zásielka",
  vratenie: "Vrátenie",
};

export function UpozorneniaResolvedList({
  canControl,
  onSessionExpired,
  onReturnedToOpen,
}: {
  readonly canControl: boolean;
  readonly onSessionExpired: () => void;
  readonly onReturnedToOpen: () => void;
}): JSX.Element {
  const [rows, setRows] = useState<readonly ResolvedUpozornenieRow[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  // Rovnaký "latest ref" princíp ako `UpozorneniaSection.tsx`'s `loadSeqRef`
  // (issue 254/251/151, `.claude/rules/frontend-design.md`) — chráni pred
  // zastaranou odpoveďou z PREDCHÁDZAJÚCEho `load()` volania (mount + refetch
  // po vrátení karty späť môžu bežať tesne po sebe).
  const loadSeqRef = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeqRef.current;
    fetchResolvedUpozornenia()
      .then((data) => {
        if (loadSeqRef.current !== seq) return;
        setRows(data);
      })
      .catch((err: unknown) => {
        if (loadSeqRef.current !== seq) return;
        if (err instanceof UpozorneniaUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Vybavené upozornenia sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(load, [load]);

  const handleReturn = useCallback(
    (row: ResolvedUpozornenieRow) => {
      setBusyId(row.id);
      setError("");
      returnUpozornenieToOpen(row.id)
        .then((result) => {
          if (result === "collision") {
            setError(`Kartu „${row.title}“ nejde vrátiť späť — na túto objednávku už otvorená karta existuje.`);
            return;
          }
          // "returned" aj "no_op" (karta medzitým prestala byť vybavená
          // odinakiaľ) obe znamenajú, že zoznam treba prekresliť.
          load();
          onReturnedToOpen();
        })
        .catch((err: unknown) => {
          if (err instanceof UpozorneniaUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setError("Vrátenie karty zlyhalo — skúste to znova.");
        })
        .finally(() => {
          setBusyId("");
        });
    },
    [load, onReturnedToOpen, onSessionExpired],
  );

  if (error !== "" && rows === null) return <p role="alert">{error}</p>;
  if (rows === null) return <p>Načítavam…</p>;

  return (
    <section data-testid="upozornenia-resolved-list">
      {error !== "" && <p role="alert">{error}</p>}

      {rows.length === RESOLVED_LIST_LIMIT && (
        <p className="upozornenia-cap-note">Zobrazených posledných {RESOLVED_LIST_LIMIT} vybavených upozornení (od najnovšie vybavených).</p>
      )}

      {rows.length === 0 ? (
        <p data-testid="upozornenia-resolved-empty">Zatiaľ nič nie je vybavené.</p>
      ) : (
        <div className="upozornenia-list">
          {rows.map((row) => {
            const rowBusy = busyId === row.id;
            return (
              <div className="card upozornenie-card" key={row.id} data-testid={`upozornenie-resolved-${row.id}`}>
                <div className="upozornenie-head">
                  <span className="pill" data-testid={`upozornenie-resolved-type-${row.id}`}>
                    {TYPE_LABELS[row.type]}
                  </span>
                  <span className="pill off">Vybavené</span>
                </div>
                <p className="upozornenie-title">{row.title}</p>
                {row.details !== "" && <p className="upozornenie-details">{row.details}</p>}
                <p className="upozornenie-meta">Vzniklo {formatSkDateTime(row.createdAt)}</p>
                <p className="upozornenie-resolved-meta" data-testid={`upozornenie-resolved-meta-${row.id}`}>
                  Vybavil(a) {row.resolvedByName ?? "automaticky"}
                  {row.resolvedAt !== null && <> · {formatSkDateTime(row.resolvedAt)}</>}
                </p>
                {canControl && (
                  <div className="upozornenie-actions">
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled={rowBusy}
                      onClick={() => {
                        handleReturn(row);
                      }}
                      data-testid={`upozornenie-return-${row.id}`}
                    >
                      ↩ Vrátiť medzi otvorené
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
