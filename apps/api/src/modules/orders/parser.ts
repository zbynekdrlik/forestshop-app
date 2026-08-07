// Vlastný parser, nie knižnica — rovnaký dôvod ako `catalog/csv.ts`: export zo
// Shoptetu má zalomenia riadkov vnútri zacitovaných buniek (napr. `remark`), a
// beží nad reťazcom stiahnutým celý naraz, takže potrebujeme generátor.

// issue 237: zdieľaný Shoptet-čiarkový money parser (`totalPriceWithVat`
// nižšie) — rovnaká logika, akú katalógový import už používa pre
// `price`/`standardPrice`/…, žiadna nová duplicitná implementácia.
import { parseDecimalComma } from "../catalog/money.js";

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

// issue 120: interné (nie zákazníkovi viditeľné) Shoptet id objednávky.
// CSV export (vyššie v tomto súbore) toto pole VÔBEC nenesie — jediný
// zdroj je SAMOSTATNÝ XML export (`patternId=-11`, `SHOPTET_ORDERS_XML_URL`),
// ktorý appka sťahuje NAVYŠE k CSV, cez rovnaké `dateFrom`/`dateUntil` okno
// (`fetcher.ts`'s `createHttpOrderIdsFetcher`). Naživo overené (dev2,
// 2026-07-31): objednávka `20260897` → `<ORDER_ID>58656</ORDER_ID>`, presne
// v ráde veľkosti majiteľovho príkladu (`id=58728` pre podobne nedávnu
// objednávku) — `.claude/rules/orders.md`'s staršia poznámka
// ("Shoptet admin nemá interné id") bola overená len proti CSV, nikdy proti
// tomto XML exportu.
//
// Zámerne JEDNODUCHÝ regex, nie plnohodnotný XML parser/DOM — z 70+ MB
// súboru potrebujeme presne DVE polia. `<ORDER_ID>` je vždy BEZPROSTREDNE
// pred OBJEDNÁVKOVÝM (nie položkovým) `<CODE>` — položky vnútri
// `<ORDER_ITEMS>` majú vlastný `<CODE>` (kód variantu), ale NIKDY pred sebou
// `<ORDER_ID>` (to sa v súbore vyskytuje presne raz na objednávku, hneď na
// začiatku `<ORDER>` bloku) — pár preto nemôže omylom zachytiť položkový kód.
const ORDER_ID_CODE_PAIR_RE = /<ORDER_ID>(\d+)<\/ORDER_ID>\s*<CODE>([^<]*)<\/CODE>/g;

/**
 * Vytiahne `Map<kód objednávky, interné Shoptet id>` zo surového XML tela
 * (`SHOPTET_ORDERS_XML_URL` export). Prázdny/nerozpoznaný kód sa preskočí —
 * rovnaká disciplína ako `mapOrderRow`'s `empty_order_code`, nikdy
 * neuloží nezmyselný kľúč.
 */
export function extractOrderIdsFromXml(xml: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const match of xml.matchAll(ORDER_ID_CODE_PAIR_RE)) {
    const orderId = Number(match[1]);
    const code = (match[2] ?? "").trim();
    if (code === "" || !Number.isFinite(orderId)) continue;
    map.set(code, orderId);
  }
  return map;
}

// issue 172: rovnaký prefix-test ako `PSEUDO_ITEM_CODE_RE` vyššie, ale
// zúžený LEN na dopravu — `extractOrderLevelExtra` potrebuje presne
// rozoznať TENTO jeden pseudo-riadok (jeho `itemName` je meno dopravcu),
// nie celú rodinu (BILLING/DISCOUNT/…).
const SHIPPING_ITEM_CODE_RE = /^SHIPPING/i;

// issue 292: rovnaký trik ako `SHIPPING_ITEM_CODE_RE` vyššie, ale pre
// PLATBU — Shoptet nemá samostatný stĺpec "spôsob platby" na objednávke,
// zapisuje ho ako `itemName` na `BILLING*` pseudo-riadku (naživo overené na
// reálnom exporte 7.8.2026: "Dobierka (hotovosť) + karta (len SR)"/"V
// hotovosti").
const BILLING_ITEM_CODE_RE = /^BILLING/i;

function trimOrNull(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

// issue 172/292: "Nevyzdvihnuté zásielky" a "DPD preprava" potrebujú
// `email`/`phone`/`packageNumber`/doručovaciu adresu/hmotnosť/spôsob platby
// — objednávkové polia, opakované na KAŽDOM riadku exportu vrátane
// pseudo-položiek (doručovacia adresa/hmotnosť/priceToPay), plus meno
// dopravcu (LEN na SHIPPING pseudo-riadku) a spôsob platby (LEN na BILLING
// pseudo-riadku). Zámerne SAMOSTATNÁ funkcia od `mapOrderRow` vyššie — tá
// zahadzuje CELÝ pseudo-riadok (nemá zmysel ako POLOŽKA objednávky), ale
// tieto polia sú OBJEDNÁVKOVÉ, nie položkové, a existujú aj na riadkoch,
// ktoré `mapOrderRow` zahodí. Nikdy nevyhadzuje/neoznamuje issue —
// chýbajúca hodnota je legitímny, bežný stav, mapuje sa jednoducho na
// `null`.
export interface OrderLevelExtra {
  readonly email: string | null;
  readonly phone: string | null;
  readonly packageNumber: string | null;
  readonly shippingCarrierName: string | null;
  readonly deliveryFullName: string | null;
  readonly deliveryCompany: string | null;
  readonly deliveryStreet: string | null;
  readonly deliveryHouseNumber: string | null;
  readonly deliveryCity: string | null;
  readonly deliveryZip: string | null;
  readonly deliveryCountryName: string | null;
  readonly weight: string | null;
  readonly paymentMethodName: string | null;
  readonly priceToPay: string | null;
}

export function extractOrderLevelExtra(row: Readonly<Record<string, string>>): OrderLevelExtra {
  const itemCode = (row["itemCode"] ?? "").trim();
  return {
    email: trimOrNull(row["email"]),
    phone: trimOrNull(row["phone"]),
    packageNumber: trimOrNull(row["packageNumber"]),
    shippingCarrierName: SHIPPING_ITEM_CODE_RE.test(itemCode) ? trimOrNull(row["itemName"]) : null,
    deliveryFullName: trimOrNull(row["deliveryFullName"]),
    deliveryCompany: trimOrNull(row["deliveryCompany"]),
    deliveryStreet: trimOrNull(row["deliveryStreet"]),
    deliveryHouseNumber: trimOrNull(row["deliveryHouseNumber"]),
    deliveryCity: trimOrNull(row["deliveryCity"]),
    deliveryZip: trimOrNull(row["deliveryZip"]),
    deliveryCountryName: trimOrNull(row["deliveryCountryName"]),
    weight: parseDecimalComma(row["weight"] ?? ""),
    paymentMethodName: BILLING_ITEM_CODE_RE.test(itemCode) ? trimOrNull(row["itemName"]) : null,
    priceToPay: parseDecimalComma(row["priceToPay"] ?? ""),
  };
}

// Skladá viac riadkov TEJ ISTEJ objednávky do jedného `OrderLevelExtra` —
// PRVÁ nájdená neprázdna hodnota KAŽDÉHO POĽA vyhráva nezávisle (nie "prvý
// riadok vyhráva celý objekt", ako `orderInfo` v `ingest.ts` robí pre
// customerName/placedAt/…) — `shippingCarrierName`/`paymentMethodName` sú
// totiž takmer vždy PRÁZDNE na bežných produktových riadkoch a NEPRÁZDNE len
// na jednom konkrétnom SHIPPING/BILLING riadku, ktorý môže byť ktorýkoľvek
// v poradí.
export function mergeOrderLevelExtra(existing: OrderLevelExtra, incoming: OrderLevelExtra): OrderLevelExtra {
  return {
    email: existing.email ?? incoming.email,
    phone: existing.phone ?? incoming.phone,
    packageNumber: existing.packageNumber ?? incoming.packageNumber,
    shippingCarrierName: existing.shippingCarrierName ?? incoming.shippingCarrierName,
    deliveryFullName: existing.deliveryFullName ?? incoming.deliveryFullName,
    deliveryCompany: existing.deliveryCompany ?? incoming.deliveryCompany,
    deliveryStreet: existing.deliveryStreet ?? incoming.deliveryStreet,
    deliveryHouseNumber: existing.deliveryHouseNumber ?? incoming.deliveryHouseNumber,
    deliveryCity: existing.deliveryCity ?? incoming.deliveryCity,
    deliveryZip: existing.deliveryZip ?? incoming.deliveryZip,
    deliveryCountryName: existing.deliveryCountryName ?? incoming.deliveryCountryName,
    weight: existing.weight ?? incoming.weight,
    paymentMethodName: existing.paymentMethodName ?? incoming.paymentMethodName,
    priceToPay: existing.priceToPay ?? incoming.priceToPay,
  };
}

export const EMPTY_ORDER_LEVEL_EXTRA: OrderLevelExtra = Object.freeze({
  email: null,
  phone: null,
  packageNumber: null,
  shippingCarrierName: null,
  deliveryFullName: null,
  deliveryCompany: null,
  deliveryStreet: null,
  deliveryHouseNumber: null,
  deliveryCity: null,
  deliveryZip: null,
  deliveryCountryName: null,
  weight: null,
  paymentMethodName: null,
  priceToPay: null,
});

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
  // issue 65: zákaznícky odkaz k objednávke (export's `remark` stĺpec — NIE
  // `shopRemark`, interná poznámka predajne, `.claude/rules/orders.md`).
  // Nepovinný stĺpec exportu — chýbajúci alebo prázdny (po orezaní) sa
  // mapuje na `null`, nikdy na prázdny reťazec.
  readonly remark: string | null;
  // issue 164: INTERNÁ poznámka e-shopu (export's `shopRemark` stĺpec 28 —
  // NIE `remark` vyššie, zákaznícky odkaz). Surová hodnota, tak ako prišla z
  // exportu (môže niesť aj náš vlastný zapísaný blok, issue 123) — rozdelenie
  // na "naše"/"cudzie" sa počíta AŽ na čítacej strane
  // (`shoptet-writeback/note-block.ts`'s `extractForeignShopRemark`, volané z
  // `queries.ts`), nikdy tu. Nepovinný stĺpec, rovnaký null-mapping ako
  // `remark`.
  readonly shopRemark: string | null;
  // issue 237: celková suma objednávky S DPH (export's `totalPriceWithVat`
  // stĺpec) — `numeric`-kompatibilný reťazec (`parseDecimalComma`) alebo
  // `null`, keď je stĺpec prázdny/nečitateľný/mimo rozsahu. VŽDY Shoptetovo
  // pole, rovnaká rodina ako `statusName`/`remark`/`shopRemark` vyššie.
  readonly totalPriceWithVat: string | null;
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

  const rawRemark = (row["remark"] ?? "").trim();
  const rawShopRemark = (row["shopRemark"] ?? "").trim();
  // issue 237: rovnaký `maxIntegerDigits` predvolený limit ako katalógov
  // peňažné stĺpce (`money.ts`'s `MONEY_MAX_INTEGER_DIGITS = 10`) — presne
  // zodpovedá `numeric(12, 2)` DB stĺpcu. Nečitateľná/mimo-rozsahu hodnota sa
  // ticho zahodí na `null` (rovnaký zámer ako `remark`/`shopRemark` —
  // nepovinné, informačné pole, nikdy dôvod zahodiť celý riadok).
  const totalPriceWithVat = parseDecimalComma(row["totalPriceWithVat"] ?? "");

  return {
    record: {
      externalOrderId,
      customerName: customerNameOf(row),
      statusName: normalizeStatusName(row["statusName"] ?? ""),
      remark: rawRemark === "" ? null : rawRemark,
      shopRemark: rawShopRemark === "" ? null : rawShopRemark,
      totalPriceWithVat,
      placedAt,
      variantCode,
      quantity,
    },
    issue: null,
  };
}
