import { deriveVariantState, effectiveAvailabilityText, type VariantState } from "./availability.js";
import { parseDate, parseDecimalComma } from "./money.js";

export type IngestIssueKind =
  | "empty_code"
  | "empty_guid"
  | "duplicate_code"
  | "invalid_money"
  | "missing_currency"
  | "invalid_stock"
  | "product_name_conflict";

export interface RowIssue {
  readonly kind: IngestIssueKind;
  readonly code: string;
  readonly detail: Record<string, string>;
}

/** Polia zodpovedajú 1:1 stĺpcom tabuľky `variant`, okrem: `supplier` (ten je
 *  stĺpec tabuľky `product`, Task 5 ho tam zapíše) a `firstSeenAt`/`lastSeenAt`/
 *  `lastSeenSnapshotId`/`missingSince` (tie dopĺňa ingest, Task 5). */
export interface VariantRecord {
  readonly code: string;
  // Identita produktu — export's `guid`, nikdy prefix `code` pred lomkou
  // (review task-5-fix-1, CRITICAL #1). FK hodnota do `product.key`.
  readonly productKey: string;
  // Tá istá hodnota ako `productKey`, uložená AJ priamo na riadku variantu —
  // pozri komentár pri stĺpci `guid` v `schema-catalog.ts`.
  readonly guid: string;
  readonly sizeLabel: string | null;
  readonly pairCode: string | null;
  readonly name: string;
  readonly supplier: string | null;
  readonly currency: string | null;
  readonly price: string | null;
  readonly standardPrice: string | null;
  readonly purchasePrice: string | null;
  readonly actionPrice: string | null;
  readonly actionFrom: string | null;
  readonly actionUntil: string | null;
  readonly percentVat: string | null;
  readonly includingVat: boolean | null;
  readonly stock: number;
  readonly availabilityInStockText: string;
  readonly availabilityOutOfStockText: string;
  readonly availabilityText: string;
  readonly productVisibility: string;
  readonly state: VariantState;
}

/**
 * Identita variantu je `code`. Vrátený `productKey` (prefix pred lomkou) UŽ
 * NIE JE identita produktu (review task-5-fix-1, CRITICAL #1) — na reálnom
 * exporte sa v oboch smeroch mýlil: zlučoval nesúvisiace produkty pod rovnaký
 * prefix (282 produktov pod "997") a rozdeľoval jeden produkt naprieč
 * viacerými prefixmi (napr. "B13/S" a "B23/S", ten istý `guid`). Identita
 * produktu je export's `guid` — pozri `mapRow` nižšie. Táto funkcia teraz
 * slúži len na odvodenie `sizeLabel` a na detekciu kódu začínajúceho lomkou
 * (čo je stále anomália samotného kódu). `pairCode` sa na identitu použiť
 * NEDÁ, je to len poradové číslo od Shoptetu a pri ~2 700 jednovariantných
 * produktoch je prázdne.
 */
export function splitCode(code: string): { readonly productKey: string; readonly sizeLabel: string | null } {
  const slash = code.indexOf("/");
  if (slash === -1) return { productKey: code, sizeLabel: null };
  const sizeLabel = code.slice(slash + 1);
  return { productKey: code.slice(0, slash), sizeLabel: sizeLabel === "" ? null : sizeLabel };
}

function textOrNull(raw: string): string | null {
  return raw === "" ? null : raw;
}

// `percent_vat` je `numeric(5, 2)` — najviac 3 číslice pred desatinnou čiarkou
// (999.99). Nie je súčasťou `variant_money_needs_currency_ck` — DPH sadzba nie
// je jednou zo štyroch súm, ktoré ten CHECK stráži — takže zostáva mimo
// menovej brány nižšie, aj keď sa parsuje rovnakým parserom a rovnakou
// anomáliou (`invalid_money`).
const PERCENT_VAT_MAX_INTEGER_DIGITS = 3;

// `stock` je stĺpec `integer` (Postgres int4).
const STOCK_MIN = -2_147_483_648;
const STOCK_MAX = 2_147_483_647;
// Striktne celé číslo — `Number.parseInt` by inak ticho prijal "12abc" ako 12
// alebo "3.9" ako 3, bez akejkoľvek anomálie.
const STRICT_INTEGER_RE = /^-?\d+$/;

const AMOUNT_FIELDS = ["price", "standardPrice", "purchasePrice", "actionPrice"] as const;

export function mapRow(row: Readonly<Record<string, string>>): {
  readonly record: VariantRecord | null;
  readonly issues: readonly RowIssue[];
} {
  const issues: RowIssue[] = [];
  const code = (row["code"] ?? "").trim();
  const name = row["name"] ?? "";

  if (code === "") {
    issues.push({ kind: "empty_code", code: "", detail: { name } });
    return { record: null, issues };
  }

  const { productKey: codePrefix, sizeLabel } = splitCode(code);
  if (codePrefix === "") {
    // Kód začínajúci lomkou (napr. "/M") — anomália samotného kódu, nezávisle
    // od toho, že identita produktu je dnes `guid`, nie tento prefix.
    // Zaobchádzame s tým rovnako ako s úplne prázdnym kódom vyššie.
    issues.push({ kind: "empty_code", code, detail: { name } });
    return { record: null, issues };
  }

  // Identita produktu je export's `guid` (review task-5-fix-1, CRITICAL #1) —
  // nemá fallback na `code`/`codePrefix`, presne ako prázdny `code` vyššie:
  // vymyslený náhradný kľúč by ticho zoskupil nesúvisiace varianty pod ním.
  const guid = (row["guid"] ?? "").trim();
  if (guid === "") {
    issues.push({ kind: "empty_guid", code, detail: { name } });
    return { record: null, issues };
  }

  const money = (field: string, maxIntegerDigits?: number): string | null => {
    const raw = row[field] ?? "";
    const parsed = parseDecimalComma(raw, maxIntegerDigits);
    if (raw.trim() !== "" && parsed === null) {
      issues.push({ kind: "invalid_money", code, detail: { field, raw } });
    }
    return parsed;
  };

  let price = money("price");
  let standardPrice = money("standardPrice");
  let purchasePrice = money("purchasePrice");
  let actionPrice = money("actionPrice");
  const currency = textOrNull((row["currency"] ?? "").trim());

  // „Suma bez meny neexistuje" — radšej zahodíme sumy, než by transakcia spadla na
  // CHECK `variant_money_needs_currency_ck` a zhodila celý import kvôli jednému riadku.
  if (currency === null && (price ?? standardPrice ?? purchasePrice ?? actionPrice) !== null) {
    const presentAmounts: Record<string, string> = {};
    for (const field of AMOUNT_FIELDS) {
      const raw = (row[field] ?? "").trim();
      if (raw !== "") presentAmounts[field] = raw;
    }
    issues.push({ kind: "missing_currency", code, detail: presentAmounts });
    price = null;
    standardPrice = null;
    purchasePrice = null;
    actionPrice = null;
  }

  const percentVat = money("percentVat", PERCENT_VAT_MAX_INTEGER_DIGITS);

  const rawStock = (row["stock"] ?? "").trim();
  let stock = 0;
  if (rawStock !== "") {
    if (!STRICT_INTEGER_RE.test(rawStock)) {
      issues.push({ kind: "invalid_stock", code, detail: { raw: rawStock } });
    } else {
      const parsed = Number.parseInt(rawStock, 10);
      if (parsed < STOCK_MIN || parsed > STOCK_MAX) {
        issues.push({ kind: "invalid_stock", code, detail: { raw: rawStock } });
      } else {
        stock = parsed;
      }
    }
  }

  const inStockText = row["availabilityInStock"] ?? "";
  const outOfStockText = row["availabilityOutOfStock"] ?? "";
  const productVisibility = row["productVisibility"] ?? "";
  // Nepretrváva vo `VariantRecord`/DB — ovplyvňuje LEN odvodenie `state` nižšie
  // (rovnaká úvaha ako u `productVisibility`, ktorá sa ukladá, no `variantVisibility`
  // samo o sebe nemá žiadneho ďalšieho konzumenta po importe).
  const variantVisibility = row["variantVisibility"] ?? "";
  const availability = { stock, inStockText, outOfStockText };

  return {
    record: {
      code,
      productKey: guid,
      guid,
      sizeLabel,
      pairCode: textOrNull((row["pairCode"] ?? "").trim()),
      name,
      supplier: textOrNull((row["supplier"] ?? "").trim()),
      currency,
      price,
      standardPrice,
      purchasePrice,
      actionPrice,
      actionFrom: parseDate(row["actionFrom"] ?? ""),
      actionUntil: parseDate(row["actionUntil"] ?? ""),
      percentVat,
      includingVat: (row["includingVat"] ?? "") === "" ? null : (row["includingVat"] ?? "") === "1",
      stock,
      availabilityInStockText: inStockText,
      availabilityOutOfStockText: outOfStockText,
      availabilityText: effectiveAvailabilityText(availability),
      productVisibility,
      state: deriveVariantState({ ...availability, productVisibility, variantVisibility }),
    },
    issues,
  };
}
