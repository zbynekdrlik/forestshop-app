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

// issue 327 (majiteľ, zákresy nad appkou v0.3.0-dev.174: "Datum dať vedľa",
// "Alebo to dať všetko vedľa"): PRVÝ riadok `details` (v praxi takmer vždy
// "Zákazník: X" — `posta-uncollected/run.ts`/`orders/return-upozornenia.ts`/
// `orders/stuck-upozornenia.ts` ho VŽDY píšu ako prvý riadok) sa presúva na
// riadok s nadpisom, spolu s "Vzniklo .../vybaviť do ...". Toto je
// ŠTRUKTURÁLNY split (prvý riadok / zvyšok podľa `\n`), nikdy parsovanie
// "Zákazník:" reťazca — funguje rovnako pre vlastné poznámky (voľný text,
// zvyčajne bez `\n` vôbec, takže CELÝ text sa jednoducho presunie vedľa
// nadpisu) aj pre AKÝKOĽVEK budúci automatický zdroj bez väzby na presnú
// formuláciu backendového textu.
// Exportovaná KVÔLI testovateľnosti (code review pred mergom, issue 327) —
// vlastný jednotkový test na hraničné prípady (`UpozornenieCard.
// splitDetailLines.test.ts`), nezávisle od renderovacích testov, ktoré ju
// pokrývajú len nepriamo.
export function splitDetailLines(details: string): { readonly first: string | null; readonly rest: string } {
  if (details === "") return { first: null, rest: "" };
  const lines = details.split("\n");
  return { first: lines[0] ?? null, rest: lines.slice(1).join("\n") };
}

// Otvorený zoznam typov — budúci ďalší automatický zdroj pridá svoj štítok
// sem, keď pridá svoju `pgEnum` hodnotu.
const TYPE_LABELS: Readonly<Record<UpozornenieRow["type"], string>> = {
  vlastna_poznamka: "Moja poznámka",
  nevyzdvihnuta_zasielka: "Nevyzdvihnutá zásielka",
  vratenie: "Vrátenie",
  // issue 299: zásielka vrátená ODOSIELATEĽOVI (Pošta SK) — nezamieňať s
  // `vratenie` vyššie (vrátený TOVAR, stav objednávky).
  vratena_zasielka: "Vrátená zásielka",
  // issue 301: objednávka dlho visiaca v nevybavenom stave.
  objednavka_visi: "Objednávka visí",
};

// Code review (issue 269, druhé kolo, finding 10): štítok odkazu sa odvodzuje
// od TYPU karty, nikdy ako natvrdo napísaný literál na mieste vykreslenia.
// `vratenie` odkazuje na Shoptet administráciu objednávky
// (`buildShoptetAdminOrderUrl`). issue 298: `nevyzdvihnuta_zasielka` odkazuje
// PRIAMO na sledovanie zásielky na Pošte SK (`trackingLink`,
// `posta-uncollected/constants.ts`) — šéfova žiadosť "preklik do pošty",
// namiesto predošlého odkazu na Shoptet admin objednávku. `vlastna_poznamka`
// nikdy nenesie `link` (server ho nikdy nevyplní), takže sem nepotrebuje
// vlastný záznam — `??` fallback nižšie pokrýva AJ ňu, AJ akýkoľvek budúci
// typ, čo by omylom dostal odkaz bez vlastného štítku.
const LINK_LABELS: Readonly<Partial<Record<UpozornenieRow["type"], string>>> = {
  nevyzdvihnuta_zasielka: "Sledovať zásielku na Pošte",
  vratenie: "Otvoriť objednávku v Shoptete",
  // issue 299: rovnaký `trackingLink` helper ako `nevyzdvihnuta_zasielka`
  // (obe sú Pošta SK zásielkové odkazy), preto rovnaký štítok.
  vratena_zasielka: "Sledovať zásielku na Pošte",
  // issue 301: rovnaký `buildShoptetAdminOrderUrl` odkaz ako `vratenie`
  // vyššie (obe sú "otvoriť objednávku v administrácii"), preto rovnaký
  // štítok.
  objednavka_visi: "Otvoriť objednávku v Shoptete",
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
  const { first: firstDetailLine, rest: restDetailLines } = splitDetailLines(row.details);
  const linkLabel = LINK_LABELS[row.type] ?? DEFAULT_LINK_LABEL;
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
      {/* issue 327: nadpis + "zákazník"/dátum na JEDNOM riadku ("Datum dať
          vedľa"). Keď karta má odkaz, nadpis SAMOTNÝ sa stane klikateľným
          odkazom (`LINK_LABELS`'ov text ostáva ako aria-label/title —
          prístupnosť + hover, keďže vizuálne ho nahradila samotná titulka) —
          samostatný odkazový riadok pod kartou zmizol. */}
      <div className="upozornenie-title-row">
        {row.link !== null ? (
          <a
            className="upozornenie-title"
            href={row.link}
            target="_blank"
            rel="noreferrer"
            aria-label={`${linkLabel} — ${row.title}`}
            title={linkLabel}
            data-testid={`upozornenie-link-${row.id}`}
          >
            {row.title}
          </a>
        ) : (
          <p className="upozornenie-title">{row.title}</p>
        )}
        <span className="upozornenie-inline-meta" data-testid={`upozornenie-meta-${row.id}`}>
          {firstDetailLine !== null && firstDetailLine !== "" && <>{firstDetailLine} · </>}
          Vzniklo {formatSkDate(row.createdAt)}
          {row.dueAt !== null && <> · vybaviť do {formatSkDate(row.dueAt)}</>}
        </span>
      </div>
      {restDetailLines !== "" && <p className="upozornenie-details">{restDetailLines}</p>}
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
          {/* issue 327 (majiteľ, zákres "Odstrániť" vedľa "Odložiť"): mazanie
              UŽ NIE JE obmedzené len na vlastné poznámky (issue 267) —
              generický text ticketu ("upozornenie odstrániť") aj umiestnenie
              v akčnom riadku (renderovanom pre VŠETKY nevyriešené karty)
              ukazujú na VŠETKY typy, nielen `isOwn`. "Upraviť" (editácia
              titulku/textu) OSTÁVA len pre vlastné poznámky nižšie — editovať
              generovaný text automatickej karty nedáva zmysel. */}
          <button type="button" className="btn sm ghost" disabled={busy} onClick={onDelete} data-testid={`upozornenie-delete-${row.id}`}>
            Odstrániť
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
            <button type="button" className="btn sm ghost" disabled={busy} onClick={onEdit} data-testid={`upozornenie-edit-${row.id}`}>
              Upraviť
            </button>
          )}
        </div>
      )}
    </div>
  );
}
