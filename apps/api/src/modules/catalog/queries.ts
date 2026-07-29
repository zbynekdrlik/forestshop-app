import { and, asc, desc, eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { catalogSnapshots, products, variants } from "../../db/schema.js";
import type { VariantState } from "./availability.js";

export interface SnapshotSummary {
  readonly id: string;
  readonly fetchedAt: string;
  // Kedy sa naposledy PREVERILO, že tento snapshot je stále aktuálny — na
  // duplicitnom importe sa posúva, `fetchedAt` nie (review final-wave-a,
  // položka 5). `null` len pri riadkoch spred tejto migrácie.
  readonly lastConfirmedAt: string | null;
  readonly sourceLabel: string;
  readonly verdict: "accepted" | "rejected";
  readonly rejectionReason: string | null;
  readonly rowCount: number;
  readonly byteSize: number;
  readonly columnCount: number;
  readonly variantCount: number | null;
  readonly productCount: number | null;
  readonly issueCount: number | null;
}

export interface VariantSummary {
  readonly code: string;
  readonly productKey: string;
  readonly sizeLabel: string | null;
  readonly name: string;
  readonly state: VariantState;
  readonly stock: number;
  readonly price: string | null;
  readonly currency: string | null;
  readonly availabilityText: string;
  readonly missingSince: string | null;
}

export interface VariantDetail extends VariantSummary {
  readonly pairCode: string | null;
  readonly supplier: string | null;
  readonly standardPrice: string | null;
  readonly purchasePrice: string | null;
  readonly actionPrice: string | null;
  readonly actionFrom: string | null;
  readonly actionUntil: string | null;
  readonly percentVat: string | null;
  readonly includingVat: boolean | null;
  readonly availabilityInStockText: string;
  readonly availabilityOutOfStockText: string;
  readonly productVisibility: string;
  readonly lastSeenAt: string;
}

export interface CatalogStats {
  readonly variantCount: number;
  readonly productCount: number;
  readonly sellable: number;
  readonly outOfStock: number;
  readonly discontinued: number;
  readonly missing: number;
  readonly lastSnapshot: SnapshotSummary | null;
}

export interface VariantSearchInput {
  readonly q: string;
  // "missing" je PSEUDO-stav (review final-wave-a, položka 6) — nie je to
  // hodnota stĺpca `variant.state`, filtruje podľa `missingSince IS NOT
  // NULL` nezávisle od toho, aký `state` mal variant naposledy pred tým, ako
  // zmizol z exportu.
  readonly state: VariantState | "all" | "missing";
  readonly page: number;
  readonly pageSize: number;
}

export interface VariantSearchResult {
  readonly total: number;
  readonly items: readonly VariantSummary[];
}

const snapshotColumns = {
  id: catalogSnapshots.id,
  fetchedAt: catalogSnapshots.fetchedAt,
  lastConfirmedAt: catalogSnapshots.lastConfirmedAt,
  sourceLabel: catalogSnapshots.sourceLabel,
  verdict: catalogSnapshots.verdict,
  rejectionReason: catalogSnapshots.rejectionReason,
  rowCount: catalogSnapshots.rowCount,
  byteSize: catalogSnapshots.byteSize,
  columnCount: sql<number>`jsonb_array_length(${catalogSnapshots.columns})`.mapWith(Number),
  variantCount: catalogSnapshots.variantCount,
  productCount: catalogSnapshots.productCount,
  issueCount: catalogSnapshots.issueCount,
};

type SnapshotRow = { readonly fetchedAt: Date; readonly lastConfirmedAt: Date | null } & Omit<
  SnapshotSummary,
  "fetchedAt" | "lastConfirmedAt"
>;

function toSnapshotSummary(row: SnapshotRow): SnapshotSummary {
  return {
    ...row,
    fetchedAt: row.fetchedAt.toISOString(),
    lastConfirmedAt: row.lastConfirmedAt?.toISOString() ?? null,
  };
}

export async function listSnapshots(db: Database, limit: number): Promise<readonly SnapshotSummary[]> {
  const rows = await db
    .select(snapshotColumns)
    .from(catalogSnapshots)
    // Sekundárne triedenie podľa `id` — dva snapshoty so zhodným `fetchedAt`
    // (rovnaká milisekunda) by inak mali nedefinované poradie a "posledný
    // snapshot" by bol pri opakovanom volaní nestabilný (review task-6-fix-1).
    .orderBy(desc(catalogSnapshots.fetchedAt), desc(catalogSnapshots.id))
    .limit(limit);
  return rows.map(toSnapshotSummary);
}

// LIKE/ILIKE berie `%` a `_` ako žolíky. Bez escapovania jeden podčiarkovník
// alebo percento vo vyhľadávanom výraze urobí zo vzoru prakticky "čokoľvek" —
// dopyt tak preskenuje a spočíta celý katalóg namiesto pár riadkov (review
// task-6-fix-1). Postgres berie spätnú lomku ako escape znak pre LIKE/ILIKE bez
// ďalšej konfigurácie — preto sa escapuje aj ona sama, a to PRVÁ, inak by
// escapovanie znaku escapovalo escape.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const summaryColumns = {
  code: variants.code,
  productKey: variants.productKey,
  sizeLabel: variants.sizeLabel,
  name: variants.name,
  state: variants.state,
  stock: variants.stock,
  price: variants.price,
  currency: variants.currency,
  availabilityText: variants.availabilityText,
  missingSince: variants.missingSince,
};

type SummaryRow = { readonly missingSince: Date | null } & Omit<VariantSummary, "missingSince">;

function toSummary(row: SummaryRow): VariantSummary {
  return { ...row, missingSince: row.missingSince?.toISOString() ?? null };
}

export async function searchVariants(
  db: Database,
  input: VariantSearchInput,
): Promise<VariantSearchResult> {
  const filters: SQL[] = [];
  if (input.q !== "") {
    // ILIKE nad `code` aj `name` — manažér hľadá raz kód, raz slovo z názvu.
    const pattern = `%${escapeLikePattern(input.q)}%`;
    const byCodeOrName = or(sql`${variants.code} ILIKE ${pattern}`, sql`${variants.name} ILIKE ${pattern}`);
    if (byCodeOrName !== undefined) filters.push(byCodeOrName);
  }
  if (input.state === "missing") filters.push(isNotNull(variants.missingSince));
  else if (input.state !== "all") filters.push(eq(variants.state, input.state));
  const where = filters.length === 0 ? undefined : and(...filters);

  const [totals] = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(variants)
    .where(where);

  const rows = await db
    .select(summaryColumns)
    .from(variants)
    .where(where)
    .orderBy(asc(variants.code))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);

  return { total: totals?.total ?? 0, items: rows.map(toSummary) };
}

export async function getVariant(db: Database, code: string): Promise<VariantDetail | null> {
  const [row] = await db
    .select({
      ...summaryColumns,
      pairCode: variants.pairCode,
      supplier: products.supplier,
      standardPrice: variants.standardPrice,
      purchasePrice: variants.purchasePrice,
      actionPrice: variants.actionPrice,
      actionFrom: variants.actionFrom,
      actionUntil: variants.actionUntil,
      percentVat: variants.percentVat,
      includingVat: variants.includingVat,
      availabilityInStockText: variants.availabilityInStockText,
      availabilityOutOfStockText: variants.availabilityOutOfStockText,
      productVisibility: variants.productVisibility,
      lastSeenAt: variants.lastSeenAt,
    })
    .from(variants)
    .innerJoin(products, eq(products.key, variants.productKey))
    .where(eq(variants.code, code))
    .limit(1);

  if (row === undefined) return null;
  return {
    ...toSummary(row),
    pairCode: row.pairCode,
    supplier: row.supplier,
    standardPrice: row.standardPrice,
    purchasePrice: row.purchasePrice,
    actionPrice: row.actionPrice,
    actionFrom: row.actionFrom,
    actionUntil: row.actionUntil,
    percentVat: row.percentVat,
    includingVat: row.includingVat,
    availabilityInStockText: row.availabilityInStockText,
    availabilityOutOfStockText: row.availabilityOutOfStockText,
    productVisibility: row.productVisibility,
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

export async function catalogStats(db: Database): Promise<CatalogStats> {
  const [counts] = await db
    .select({
      variantCount: sql<number>`count(*)`.mapWith(Number),
      sellable: sql<number>`count(*) filter (where ${variants.state} = 'sellable')`.mapWith(Number),
      outOfStock: sql<number>`count(*) filter (where ${variants.state} = 'out_of_stock')`.mapWith(Number),
      discontinued: sql<number>`count(*) filter (where ${variants.state} = 'discontinued')`.mapWith(Number),
      missing: sql<number>`count(*) filter (where ${variants.missingSince} is not null)`.mapWith(Number),
    })
    .from(variants);

  const [productTotal] = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(products);

  const [snapshot] = await db
    .select(snapshotColumns)
    .from(catalogSnapshots)
    .orderBy(desc(catalogSnapshots.fetchedAt))
    .limit(1);

  return {
    variantCount: counts?.variantCount ?? 0,
    productCount: productTotal?.total ?? 0,
    sellable: counts?.sellable ?? 0,
    outOfStock: counts?.outOfStock ?? 0,
    discontinued: counts?.discontinued ?? 0,
    missing: counts?.missing ?? 0,
    lastSnapshot: snapshot === undefined ? null : toSnapshotSummary(snapshot),
  };
}
