import { deriveVariantState, effectiveAvailabilityText, type VariantState } from "./availability.js";
import { parseDate, parseDecimalComma } from "./money.js";

export type IngestIssueKind =
  | "empty_code"
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

/** Polia zodpovedajú 1:1 stĺpcom tabuľky `variant` okrem `firstSeenAt`/`lastSeenAt`/
 *  `lastSeenSnapshotId`/`missingSince`, ktoré dopĺňa ingest (Task 5). */
export interface VariantRecord {
  readonly code: string;
  readonly productKey: string;
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
 * Identita variantu je `code`. Identita produktu je časť pred prvou lomkou —
 * `pairCode` sa na to použiť NEDÁ, je to len poradové číslo od Shoptetu a pri
 * ~2 700 jednovariantných produktoch je prázdne.
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

  const money = (field: string): string | null => {
    const raw = row[field] ?? "";
    const parsed = parseDecimalComma(raw);
    if (raw.trim() !== "" && parsed === null) {
      issues.push({ kind: "invalid_money", code, detail: { field, raw } });
    }
    return parsed;
  };

  let price = money("price");
  let standardPrice = money("standardPrice");
  let purchasePrice = money("purchasePrice");
  let actionPrice = money("actionPrice");
  let currency = textOrNull((row["currency"] ?? "").trim());

  // „Suma bez meny neexistuje" — radšej zahodíme sumy, než by transakcia spadla na
  // CHECK `variant_money_needs_currency_ck` a zhodila celý import kvôli jednému riadku.
  if (currency === null && (price ?? standardPrice ?? purchasePrice ?? actionPrice) !== null) {
    issues.push({
      kind: "missing_currency",
      code,
      detail: { price: row["price"] ?? "" },
    });
    price = null;
    standardPrice = null;
    purchasePrice = null;
    actionPrice = null;
    currency = null;
  }

  const rawStock = (row["stock"] ?? "").trim();
  let stock = 0;
  if (rawStock !== "") {
    const parsed = Number.parseInt(rawStock, 10);
    if (Number.isNaN(parsed)) {
      issues.push({ kind: "invalid_stock", code, detail: { raw: rawStock } });
    } else {
      stock = parsed;
    }
  }

  const inStockText = row["availabilityInStock"] ?? "";
  const outOfStockText = row["availabilityOutOfStock"] ?? "";
  const productVisibility = row["productVisibility"] ?? "";
  const availability = { stock, inStockText, outOfStockText };
  const { productKey, sizeLabel } = splitCode(code);

  return {
    record: {
      code,
      productKey,
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
      percentVat: parseDecimalComma(row["percentVat"] ?? ""),
      includingVat: (row["includingVat"] ?? "") === "" ? null : (row["includingVat"] ?? "") === "1",
      stock,
      availabilityInStockText: inStockText,
      availabilityOutOfStockText: outOfStockText,
      availabilityText: effectiveAvailabilityText(availability),
      productVisibility,
      state: deriveVariantState({ ...availability, productVisibility }),
    },
    issues,
  };
}
