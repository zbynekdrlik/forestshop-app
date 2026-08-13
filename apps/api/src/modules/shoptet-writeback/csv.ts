/**
 * Shoptet bulk-import CSV — presne dialekt overený naživo v sesterskom
 * projekte `parovanie_produktov` (`src/parovanie/writer.py`'s
 * `shoptet_writer`/`write_import`): UTF-8 s BOM, `;` oddeľovač, CRLF, hlavička
 * `code;pairCode;internalNote`. Shoptet PREPÍŠE prítomný-ale-prázdny stĺpec
 * (vymaže existujúcu hodnotu) — preto tento súbor nesie LEN tieto tri
 * stĺpce, nikdy viac (issue 122's zadanie: "iba také stĺpce, ktoré chce
 * zmeniť" + párovacie stĺpce).
 */

import { csvSafe } from "./formula-guard.js";

export interface WritebackRow {
  readonly code: string;
  readonly pairCode: string;
  readonly internalNote: string;
}

const HEADER = ["code", "pairCode", "internalNote"] as const;

/** Shoptet CSV field-quoting: quote only when the value needs it (contains
 * the delimiter, a double quote, or a line break), doubling any inner quote —
 * the standard CSV escaping rule, same as Python's csv.QUOTE_MINIMAL. */
function quoteField(value: string): string {
  if (/[;"\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowToLine(values: readonly string[]): string {
  return values.map(quoteField).join(";");
}

// issue 153: CSV-injection ochrana PRI ZÁPISE — `csvSafe` sa aplikuje na
// KAŽDÚ bunku DÁTOVÉHO riadku (nie na hlavičku, tá je statická), bez ohľadu
// na to, čo už overila validácia vyššie (`code`/`pairCode` prichádzajú z
// katalógového importu, ktorý ŽIADNU takú kontrolu nerobí). Poradie MUSÍ byť
// `csvSafe` PRED `quoteField` — pridaná úvodná `'` sama osebe nikdy
// nevyžaduje CSV-uvodzovanie, ale pôvodná hodnota môže, takže `quoteField`
// beží AŽ na výslednom (už neutralizovanom) reťazci.
function dataRowToLine(values: readonly string[]): string {
  return values.map(csvSafe).map(quoteField).join(";");
}

/**
 * Builds the write-back CSV as a Buffer ready to upload — UTF-8 BOM prefix,
 * one row per given variant (caller decides which variants: one per changed
 * product's variant codes, `select-changes.ts`). Throws when given no rows —
 * Shoptet's bulk import must never be invoked with a file that changes
 * nothing.
 */
export function buildWritebackCsv(rows: readonly WritebackRow[]): Buffer {
  if (rows.length === 0) {
    throw new Error("buildWritebackCsv: žiadne riadky na zápis — CSV sa nesmie nahrať prázdne");
  }
  const lines = [rowToLine(HEADER), ...rows.map((r) => dataRowToLine([r.code, r.pairCode, r.internalNote]))];
  const bom = "﻿";
  return Buffer.from(bom + lines.join("\r\n") + "\r\n", "utf8");
}

// issue 213: prepnutie vypredaného produktu späť na „Skladom". Vlastný tvar
// riadku (iné stĺpce než odkaz na dodávateľa vyššie), ale ZÁMERNE v tomto
// súbore a cez to isté `dataRowToLine` — ochrana proti CSV-injection
// (`.claude/rules/shoptet-writeback.md`) platí pre KAŽDÚ cestu zápisu do
// Shoptetu, nikdy sa stĺpce neskladajú mimo tohto modulu.
export interface RestockCsvRow {
  readonly code: string;
  readonly pairCode: string;
  readonly availabilityInStock: string;
  readonly availabilityOutOfStock: string;
}

// `visible` je konštanta, nie vstup — automatizácia zapína LEN produkty,
// ktoré už `visible` sú (`restock/queries.ts`), takže stĺpec len potvrdzuje
// existujúci stav a nemôže odkryť nič, čo majiteľ skryl.
// `stock` sa ZÁMERNE nezapisuje (issue 219). Majiteľ skladovú logistiku v
// Shoptete nepoužíva — fiktívna zásoba by mu do obchodu vpísala číslo, ktoré
// nikto neudržiava. Na zobrazenie „Skladom" nie je potrebná: oba texty
// dostupnosti sa nastavujú naraz, takže je jedno, ktorý z nich Shoptet podľa
// zásoby vyberie.
const RESTOCK_HEADER = [
  "code",
  "pairCode",
  "productVisibility",
  "availabilityInStock",
  "availabilityOutOfStock",
] as const;

export function buildRestockCsv(rows: readonly RestockCsvRow[]): Buffer {
  if (rows.length === 0) {
    throw new Error("buildRestockCsv: žiadne riadky na zápis — CSV sa nesmie nahrať prázdne");
  }
  const lines = [
    rowToLine(RESTOCK_HEADER),
    ...rows.map((r) =>
      dataRowToLine([r.code, r.pairCode, "visible", r.availabilityInStock, r.availabilityOutOfStock]),
    ),
  ];
  const bom = "﻿";
  return Buffer.from(bom + lines.join("\r\n") + "\r\n", "utf8");
}

// issue 387 E7: stavový zápis (rozhodnutia "📦 Nie je skladom"/"🚫 Už sa
// nebude predávať" z obrazovky Párovanie) — DRUHÝ, SAMOSTATNÝ CSV import,
// nikdy kombinovaný s linkovým vyššie. Vlastný tvar riadku (stĺpce sú
// DISJUNKTNÉ od `WritebackRow` — žiadny `internalNote`, takže existujúce
// dodávateľské odkazy ostávajú nedotknuté), ale ZÁMERNE v tomto súbore a
// cez to isté `dataRowToLine` — CSV-injection ochrana platí pre KAŽDÚ
// cestu zápisu do Shoptetu.
export type StateWritebackStatus = "unavailable" | "discontinued";

export interface StateCsvRow {
  readonly code: string;
  readonly pairCode: string;
  readonly status: StateWritebackStatus;
}

const STATE_HEADER = ["code", "pairCode", "productVisibility", "stock", "availabilityInStock", "availabilityOutOfStock"] as const;

// Mapovanie stavov — presne stará appka's zákon (`import_builder.py`'s
// `state_rows`/`export_helpers.py`'s `_VYPREDANE`/`_SKONCIL`): unavailable →
// visible/Vypredané (produkt ostáva viditeľný, môže sa neskôr prepnúť späť —
// `.claude/rules/supplier-stock.md`'s restock automatika naň smie zareagovať),
// discontinued → detailOnly/Predaj výrobku skončil (stránka ostáva kvôli
// Google, ale restock ho už nikdy neprepne späť — `detailOnly` je mimo
// `HIDDEN_VISIBILITIES`, ale AJ mimo `SELLABLE_VISIBILITY`). `stock` sa
// nezapisuje (issue 219's dôvod platí rovnako — majiteľ zásobu neudržiava),
// oba dostupnostné texty sa zapisujú NARAZ (issue 219).
const STATE_VISIBILITY: Record<StateWritebackStatus, string> = { unavailable: "visible", discontinued: "detailOnly" };
const STATE_AVAILABILITY_TEXT: Record<StateWritebackStatus, string> = {
  unavailable: "Vypredané",
  discontinued: "Predaj výrobku skončil",
};

/**
 * Dedup podľa `code`, PRVÝ výskyt vyhráva — stará appka's zákon ("Each code
 * appears ONCE — Shoptet aborts the whole import on a duplicate code").
 * `variants.code` je v tejto appke DB primárny kľúč (`schema-catalog.ts`),
 * takže skutočný duplikát v `rows` je štrukturálne nedosiahnuteľný pri
 * korektnom volajúcom — táto funkcia je obranná vrstva navyše, nikdy
 * jediná ochrana. Exportovaná samostatne (nie len vnorená v
 * `buildStatesCsv`), aby volajúci (`run-state-writeback.ts`) mohol z NEJ
 * istej odvodiť presný `expectedRows` pre Log-overenie výsledku importu —
 * jeden zdroj pravdy pre "koľko riadkov sa reálne zapíše".
 */
export function dedupeStateRowsByCode(rows: readonly StateCsvRow[]): readonly StateCsvRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.code)) return false;
    seen.add(r.code);
    return true;
  });
}

export function buildStatesCsv(rows: readonly StateCsvRow[]): Buffer {
  if (rows.length === 0) {
    throw new Error("buildStatesCsv: žiadne riadky na zápis — CSV sa nesmie nahrať prázdne");
  }
  const deduped = dedupeStateRowsByCode(rows);
  const lines = [
    rowToLine(STATE_HEADER),
    ...deduped.map((r) => {
      const text = STATE_AVAILABILITY_TEXT[r.status];
      return dataRowToLine([r.code, r.pairCode, STATE_VISIBILITY[r.status], "0", text, text]);
    }),
  ];
  const bom = "﻿";
  return Buffer.from(bom + lines.join("\r\n") + "\r\n", "utf8");
}
