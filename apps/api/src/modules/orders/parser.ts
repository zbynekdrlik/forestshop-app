// Vlastný parser, nie knižnica — rovnaký dôvod ako `catalog/csv.ts`: export zo
// Shoptetu má zalomenia riadkov vnútri zacitovaných buniek (napr. `remark`), a
// beží nad reťazcom stiahnutým celý naraz, takže potrebujeme generátor.

export function decodeCp1250(body: Buffer): string {
  // Node 24 má plné ICU, takže windows-1250 je vstavané — žiadna závislosť navyše.
  return new TextDecoder("windows-1250").decode(body);
}

export function* parseDelimited(text: string, delimiter = ";"): Generator<string[]> {
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let started = false;
  let i = 0;

  while (i < text.length) {
    const ch = text.charAt(i);

    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      started = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      started = true;
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text.charAt(i + 1) === "\n") i += 1;
      i += 1;
      if (started || field !== "" || row.length > 0) {
        row.push(field);
        yield row;
      }
      field = "";
      row = [];
      started = false;
      continue;
    }

    field += ch;
    started = true;
    i += 1;
  }

  if (inQuotes) {
    throw new Error(
      "Súbor sa skončil vnútri zacitovanej bunky — export objednávok je neúplný a nedá sa spoľahlivo rozparsovať.",
    );
  }

  if (started || field !== "" || row.length > 0) {
    row.push(field);
    yield row;
  }
}

/**
 * Stĺpce, bez ktorých sa export nedá spracovať vôbec — pokrýva identitu
 * objednávky (`code`), kedy bola vytvorená (`date`), meno zákazníka
 * (`billFullName`) a samotnú položku (`itemName`/`itemAmount`/`itemCode`).
 * Chýbajúci ktorýkoľvek z nich znamená, že Shoptet zmenil tvar exportu — import
 * sa má odmietnuť ako celok (`ingest.ts`), nie ticho zapísať polovičné dáta.
 */
export const REQUIRED_ORDER_COLUMNS: readonly string[] = Object.freeze([
  "code",
  "date",
  "billFullName",
  "itemName",
  "itemAmount",
  "itemCode",
  // issue 59: bez tohto stĺpca appka nemá podľa čoho rozhodnúť, ktoré
  // objednávky patria do "Na objednanie" — chýbajúci stĺpec preto odmieta
  // CELÝ import nahlas (rovnaká disciplína ako zvyšok zoznamu), nikdy ticho
  // nezapíše polovičné dáta bez stavu.
  "statusName",
]);

function toRecord(columns: readonly string[], values: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i < columns.length; i += 1) {
    const name = columns[i] ?? "";
    // Export končí bodkočiarkou, takže posledný stĺpec má prázdne meno.
    if (name === "") continue;
    record[name] = values[i] ?? "";
  }
  return record;
}

export interface ShoptetOrdersCsv {
  readonly columns: readonly string[];
  rows(): Generator<Readonly<Record<string, string>>>;
}

export function parseShoptetOrdersCsv(body: Buffer): ShoptetOrdersCsv {
  const text = decodeCp1250(body);
  const first = parseDelimited(text).next();
  const columns: readonly string[] = first.done === true ? [] : first.value;

  return {
    columns,
    *rows(): Generator<Readonly<Record<string, string>>> {
      let isHeader = true;
      for (const values of parseDelimited(text)) {
        if (isHeader) {
          isHeader = false;
          continue;
        }
        yield toRecord(columns, values);
      }
    },
  };
}

/**
 * Shoptet zapisuje do `itemCode` aj pseudo-položky objednávky (doprava,
 * platba, zľava) — nikdy nebudú v `variant` tabuľke, lebo nie sú produkt.
 * Zistené naživo (2026-07-29, 90-dňový export): `SHIPPING4/6/11/14/23/26`,
 * `BILLING2/3/5/10`, `DISCOUNT`. Prefixy (case-insensitive) pokrývajú celú
 * rodinu bez toho, aby sa musel vypisovať každý konkrétny sadzobník zvlášť.
 */
const PSEUDO_ITEM_CODE_RE = /^(SHIPPING|BILLING|DISCOUNT|GIFT|VOUCHER|CERT)/i;

// `itemAmount` bol v CELOM stiahnutom exporte (63 396 riadkov, 2016–2026)
// vždy presný celočíselný reťazec — žiadna desatinná čiarka, žiadny záporný
// tvar. Prísna kontrola (rovnaký vzor ako katalóg's `stock`) namiesto
// `Number.parseInt`, ktorý by ticho prijal "3abc" ako 3.
const STRICT_INTEGER_RE = /^\d+$/;

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * Shoptet's `date` pole nenesie časovú zónu — je to miestny (Europe/Bratislava)
 * čas obchodu. Prevod na UTC cez pevný offset (+1/+2) by pri prechode na/z
 * letného času (posledná marcová/októbrová nedeľa) ticho posunul objednávky
 * o hodinu. Namiesto toho: naivný reťazec sa najprv interpretuje AKOBY bol UTC
 * (hádaný okamih), ten sa naformátuje SPÄŤ do cieľovej zóny cez vstavaný
 * `Intl.DateTimeFormat` (Node 24 má plné ICU aj IANA databázu zón) — rozdiel
 * medzi hádaným okamihom a tým, čo zóna v ten okamih ukazuje, JE offset zóny
 * (vrátane DST), odpočíta sa od hádaného okamihu. Bežný trik na "naivný lokálny
 * čas → UTC" bez knižnice typu date-fns-tz.
 */
export function parseShopLocalDateTime(raw: string, timeZone = "Europe/Bratislava"): Date | null {
  const match = DATETIME_RE.exec(raw.trim());
  if (match === null) return null;
  const [, y, mo, d, h, mi, s] = match as unknown as [string, string, string, string, string, string, string];

  const guessUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(guessUtc));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const zonedAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = zonedAsUtc - guessUtc;
  return new Date(guessUtc - offsetMs);
}

export type OrderRowIssueKind =
  | "empty_order_code"
  | "empty_item_code"
  | "pseudo_item"
  | "invalid_quantity"
  | "unparseable_date";

export interface OrderRowIssue {
  readonly kind: OrderRowIssueKind;
  readonly orderCode: string;
  readonly detail: Record<string, string>;
}

export interface OrderLineCandidate {
  readonly externalOrderId: string;
  readonly customerName: string;
  // issue 59: Shoptet-ov stav objednávky, normalizovaný (`normalizeStatusName`).
  readonly statusName: string;
  readonly placedAt: Date;
  readonly variantCode: string;
  readonly quantity: number;
}

/**
 * issue 59: `statusName` je voľný text, ktorý si obchod nastavuje priamo v
 * Shoptete, a appka ho porovnáva na DVOCH miestach — raz z exportu (tu),
 * raz z toho, čo správca zapíše do `order_open_status` (`open-statuses.ts`).
 * NFC normalizácia + orez sú nutné, aby oba zdroje porovnávali v ROVNAKEJ
 * forme (rovnaký dôvod ako stará appka's `norm_status`, `export_helpers.py`):
 * "Vybavuje sa" vložené zo zdroja, ktorý rozkladá diakritiku, vyzerá na
 * obrazovke identicky, ale je bajtovo iné a nezhodovalo by sa s ničím.
 */
export function normalizeStatusName(value: string): string {
  return value.normalize("NFC").trim();
}

function customerNameOf(row: Readonly<Record<string, string>>): string {
  const bill = (row["billFullName"] ?? "").trim();
  if (bill !== "") return bill;
  const delivery = (row["deliveryFullName"] ?? "").trim();
  if (delivery !== "") return delivery;
  // Oba mená prázdne sa v 63 396-riadkovej histórii nevyskytli ani raz, ale
  // `customerName` je `NOT NULL` — radšej explicitný, čitateľný zástupný text
  // než by transakcia spadla na chýbajúcej hodnote kvôli jedinému riadku.
  return "(bez mena)";
}

/**
 * Zmapuje JEDEN riadok exportu (= jedna položka objednávky) na kandidáta
 * riadku objednávky, alebo vráti dôvod, prečo sa riadok preskakuje. Na rozdiel
 * od katalógu (kde jeden riadok môže mať VIACERO čiastočných anomálií a
 * napriek tomu vyrobiť záznam) tu platí: akýkoľvek problém → riadok sa
 * PRESKOČÍ celý (žiadny čiastočný zápis položky objednávky nemá zmysel).
 */
export function mapOrderRow(row: Readonly<Record<string, string>>): {
  readonly record: OrderLineCandidate | null;
  readonly issue: OrderRowIssue | null;
} {
  const externalOrderId = (row["code"] ?? "").trim();
  if (externalOrderId === "") {
    return { record: null, issue: { kind: "empty_order_code", orderCode: "", detail: {} } };
  }

  const variantCode = (row["itemCode"] ?? "").trim();
  if (variantCode === "") {
    return {
      record: null,
      issue: { kind: "empty_item_code", orderCode: externalOrderId, detail: { itemName: row["itemName"] ?? "" } },
    };
  }
  if (PSEUDO_ITEM_CODE_RE.test(variantCode)) {
    return {
      record: null,
      issue: { kind: "pseudo_item", orderCode: externalOrderId, detail: { itemCode: variantCode } },
    };
  }

  const rawAmount = (row["itemAmount"] ?? "").trim();
  if (!STRICT_INTEGER_RE.test(rawAmount) || Number.parseInt(rawAmount, 10) <= 0) {
    return {
      record: null,
      issue: { kind: "invalid_quantity", orderCode: externalOrderId, detail: { itemAmount: rawAmount } },
    };
  }
  const quantity = Number.parseInt(rawAmount, 10);

  const placedAt = parseShopLocalDateTime(row["date"] ?? "");
  if (placedAt === null) {
    return {
      record: null,
      issue: { kind: "unparseable_date", orderCode: externalOrderId, detail: { date: row["date"] ?? "" } },
    };
  }

  return {
    record: {
      externalOrderId,
      customerName: customerNameOf(row),
      statusName: normalizeStatusName(row["statusName"] ?? ""),
      placedAt,
      variantCode,
      quantity,
    },
    issue: null,
  };
}
