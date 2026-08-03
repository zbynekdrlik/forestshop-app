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
  readonly stock: string;
}

// `visible` je konštanta, nie vstup — automatizácia zapína LEN produkty,
// ktoré už `visible` sú (`restock/queries.ts`), takže stĺpec len potvrdzuje
// existujúci stav a nemôže odkryť nič, čo majiteľ skryl.
const RESTOCK_HEADER = [
  "code",
  "pairCode",
  "productVisibility",
  "availabilityInStock",
  "availabilityOutOfStock",
  "stock",
] as const;

export function buildRestockCsv(rows: readonly RestockCsvRow[]): Buffer {
  if (rows.length === 0) {
    throw new Error("buildRestockCsv: žiadne riadky na zápis — CSV sa nesmie nahrať prázdne");
  }
  const lines = [
    rowToLine(RESTOCK_HEADER),
    ...rows.map((r) =>
      dataRowToLine([r.code, r.pairCode, "visible", r.availabilityInStock, r.availabilityOutOfStock, r.stock]),
    ),
  ];
  const bom = "﻿";
  return Buffer.from(bom + lines.join("\r\n") + "\r\n", "utf8");
}
