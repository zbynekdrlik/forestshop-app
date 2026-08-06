import type { JSX } from "react";
import { formatSkDate } from "../formatDate.js";
import type { UpozornenieRow } from "../upozorneniaApi.js";

// issue 283 (code review — súbor `UpozorneniaSection.tsx` prerástol eslint
// `max-lines: 400` po pridaní záložky "Vybavené"): rovnaký zavedený vzor ako
// `OrderLineRow.tsx`/`OrdersSection.tsx` (`.claude/rules/frontend-design.md`
// — "TABLE ROW / list-item rendering sa extrahuje ako prvé, je takmer vždy
// najväčší a najsamostatnejší kus"). Karta je čisto zobrazovacia + callbacky
// z rodiča — vlastný stav (`busyId`/`postponeDraft`/`draft`) ostáva v
// `UpozorneniaSection.tsx`, ktorý je jediný, čo ho potrebuje zdieľať naprieč
// viacerými kartami naraz.

// Otvorený zoznam typov — budúci ďalší automatický zdroj pridá svoj štítok
// sem, keď pridá svoju `pgEnum` hodnotu.
const TYPE_LABELS: Readonly<Record<UpozornenieRow["type"], string>> = {
  vlastna_poznamka: "Moja poznámka",
  nevyzdvihnuta_zasielka: "Nevyzdvihnutá zásielka",
  vratenie: "Vrátenie",
};

// Code review (issue 269, druhé kolo, finding 10): štítok odkazu sa odvodzuje
// od TYPU karty, nikdy ako natvrdo napísaný literál na mieste vykreslenia —
// oba dnešné automatické zdroje (#268 nevyzdvihnutá zásielka, #269 vrátenie)
// odkazujú na Shoptet administráciu objednávky (`buildShoptetAdminOrderUrl`),
// takže majú rovnaký štítok. `vlastna_poznamka` nikdy nenesie `link` (server
// ho nikdy nevyplní), takže sem nepotrebuje vlastný záznam — `??` fallback
// nižšie pokrýva AJ ňu, AJ akýkoľvek budúci typ, čo by omylom dostal odkaz
// bez vlastného štítku, namiesto tichého predpokladu "je to vždy Shoptet".
const LINK_LABELS: Readonly<Partial<Record<UpozornenieRow["type"], string>>> = {
  nevyzdvihnuta_zasielka: "Otvoriť objednávku v Shoptete",
  vratenie: "Otvoriť objednávku v Shoptete",
};
const DEFAULT_LINK_LABEL = "Otvoriť odkaz";

// Code review: "Odložiť do" nemalo `min` — dalo sa vybrať dátum v minulosti
// (neškodné, `computeStatus` by ho vzalo ako "už sa vrátilo", ale mätúce
// no-op). `<input type="date">`'s `min` očakáva `YYYY-MM-DD` v LOKÁLNOM
// čase prehliadača, nie `toISOString()` (tá by okolo polnoci mohla ukázať
// VČEREJŠÍ dátum v časových pásmach východne od UTC).
function todayDateInputValue(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${String(y)}-${m}-${d}`;
}

export interface UpozornenieCardProps {
  readonly row: UpozornenieRow;
  readonly canControl: boolean;
  readonly busy: boolean;
  readonly postponeDraftValue: string;
  readonly onPostponeDraftChange: (value: string) => void;
  readonly onResolve: () => void;
  readonly onPostpone: () => void;
  readonly onCancelPostpone: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}

export function UpozornenieCard({
  row,
  canControl,
  busy,
  postponeDraftValue,
  onPostponeDraftChange,
  onResolve,
  onPostpone,
  onCancelPostpone,
  onEdit,
  onDelete,
}: UpozornenieCardProps): JSX.Element {
  const isOwn = row.source === "vlastne";
  return (
    <div className={"card upozornenie-card" + (row.status === "nove" ? " upozornenie-nove" : "")} data-testid={`upozornenie-${row.id}`}>
      <div className="upozornenie-head">
        <span className="pill" data-testid={`upozornenie-type-${row.id}`}>
          {TYPE_LABELS[row.type]}
        </span>
        {row.status === "nove" && <strong data-testid={`upozornenie-nove-${row.id}`}>Nové</strong>}
        {row.status === "odlozene" && (
          <span className="pill" data-testid={`upozornenie-odlozene-${row.id}`}>
            Odložené{row.postponedUntil !== null && <> do {formatSkDate(row.postponedUntil)}</>}
          </span>
        )}
      </div>
      <p className="upozornenie-title">{row.title}</p>
      {row.details !== "" && <p className="upozornenie-details">{row.details}</p>}
      <p className="upozornenie-meta">
        Vzniklo {formatSkDate(row.createdAt)}
        {row.dueAt !== null && <> · vybaviť do {formatSkDate(row.dueAt)}</>}
      </p>
      {row.link !== null && (
        <a href={row.link} target="_blank" rel="noreferrer" data-testid={`upozornenie-link-${row.id}`}>
          {LINK_LABELS[row.type] ?? DEFAULT_LINK_LABEL}
        </a>
      )}
      {canControl && row.status !== "vybavene" && (
        <div className="upozornenie-actions">
          <button type="button" className="btn sm good" disabled={busy} onClick={onResolve} data-testid={`upozornenie-resolve-${row.id}`}>
            ✓ Vybavené
          </button>
          <input
            type="date"
            min={todayDateInputValue()}
            value={postponeDraftValue}
            onChange={(e) => {
              onPostponeDraftChange(e.target.value);
            }}
            aria-label={`Odložiť do — ${row.title}`}
            data-testid={`upozornenie-postpone-date-${row.id}`}
          />
          <button type="button" className="btn sm ghost" disabled={busy || postponeDraftValue === ""} onClick={onPostpone} data-testid={`upozornenie-postpone-${row.id}`}>
            Odložiť
          </button>
          {row.status === "odlozene" && (
            // issue 267 (živé overenie, gap 2): jediný spôsob, ako vrátiť
            // odloženú kartu SKÔR, než sa vráti sama (napr. majiteľ sa
            // pomýlil v dátume).
            <button type="button" className="btn sm ghost" disabled={busy} onClick={onCancelPostpone} data-testid={`upozornenie-cancel-postpone-${row.id}`}>
              Zrušiť odloženie
            </button>
          )}
          {isOwn && (
            <>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={onEdit} data-testid={`upozornenie-edit-${row.id}`}>
                Upraviť
              </button>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={onDelete} data-testid={`upozornenie-delete-${row.id}`}>
                ✕ Zmazať
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
