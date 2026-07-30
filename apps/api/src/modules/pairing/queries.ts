import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairings, products, users, variants } from "../../db/schema.js";
import { escapeLikePattern } from "../catalog/queries.js";

// Zrkadlí `PairingState` zo schémy (`schema-pairing.ts`'s `pairingState`
// enum), ale drží sa aj bez importu typu odtiaľ — jednoduchý reťazcový
// literál je tu čitateľnejší než ďalší cyklus importov.
export type PairingDisplayState = "navrhnute" | "potvrdene";

export interface PairingListItem {
  readonly variantCode: string;
  readonly variantName: string;
  readonly sizeLabel: string | null;
  // `product.supplier` — INFORMATÍVNY reťazec zo Shoptet exportu (kto nám
  // produkt oficiálne dodáva), NIE cieľ párovania. Cieľ párovania je
  // `supplierUrl` nižšie (konkrétna adresa produktu u veľkoobchodného
  // dodávateľa, viď `schema-pairing.ts`).
  readonly productSupplier: string | null;
  readonly supplierUrl: string | null;
  // Chýbajúci `pairing` riadok (žiadny kandidát zatiaľ nebol navrhnutý ani
  // ručne zadaný — #46 automatické hľadanie kandidátov ešte neexistuje) sa
  // zobrazuje ako "navrhnute" s `supplierUrl: null` — presne zodpovedá
  // počiatočnému stavu DB automatu (`pairing_confirmation_ck`), len bez
  // toho, že by preň musel existovať riadok.
  readonly state: PairingDisplayState;
  readonly confirmedByName: string | null;
  readonly confirmedAt: string | null;
}

export interface PairingSearchInput {
  readonly q: string;
  readonly state: "all" | PairingDisplayState;
  readonly page: number;
  readonly pageSize: number;
}

export interface PairingSearchResult {
  readonly total: number;
  readonly items: readonly PairingListItem[];
}

const listColumns = {
  variantCode: variants.code,
  variantName: variants.name,
  sizeLabel: variants.sizeLabel,
  productSupplier: products.supplier,
  supplierUrl: pairings.supplierUrl,
  pairingState: pairings.state,
  confirmedByName: users.displayName,
  confirmedAt: pairings.confirmedAt,
};

type ListRow = {
  readonly variantCode: string;
  readonly variantName: string;
  readonly sizeLabel: string | null;
  readonly productSupplier: string | null;
  readonly supplierUrl: string | null;
  readonly pairingState: PairingDisplayState | null;
  readonly confirmedByName: string | null;
  readonly confirmedAt: Date | null;
};

function toItem(row: ListRow): PairingListItem {
  return {
    variantCode: row.variantCode,
    variantName: row.variantName,
    sizeLabel: row.sizeLabel,
    productSupplier: row.productSupplier,
    supplierUrl: row.supplierUrl,
    // Chýbajúci riadok (LEFT JOIN nenašiel zhodu) → `pairingState` je `null`
    // → zobrazí sa ako "navrhnute" (viď komentár pri `PairingListItem.state`).
    state: row.pairingState ?? "navrhnute",
    confirmedByName: row.confirmedByName,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  };
}

// LEFT JOIN na `pairing` aj `users` (nie INNER) — zámerné, viď návrhový
// komentár na issue 45: `pairing` dnes nemá ANI JEDEN riadok (#46 automatické
// hľadanie kandidátov ešte neexistuje), INNER JOIN by preto vrátil vždy
// prázdny zoznam. `users` LEFT JOIN zo symetrického dôvodu — nepotvrdený
// pairing nemá `confirmed_by` vôbec.
export async function listPairings(db: Database, input: PairingSearchInput): Promise<PairingSearchResult> {
  const filters: SQL[] = [];
  if (input.q !== "") {
    // ILIKE nad `code` aj `name`, rovnaký zámer ako katalógové vyhľadávanie —
    // manažér hľadá raz kód variantu, raz slovo z názvu produktu.
    const pattern = `%${escapeLikePattern(input.q)}%`;
    const byCodeOrName = or(sql`${variants.code} ILIKE ${pattern}`, sql`${variants.name} ILIKE ${pattern}`);
    if (byCodeOrName !== undefined) filters.push(byCodeOrName);
  }
  if (input.state !== "all") {
    // `coalesce` — chýbajúci riadok sa pri filtrovaní musí správať PRESNE
    // tak, ako sa zobrazuje (viď `toItem` vyššie), inak by filter "navrhnute"
    // ticho vynechával práve tie varianty, ktoré ho najviac potrebujú.
    filters.push(sql`coalesce(${pairings.state}, 'navrhnute') = ${input.state}`);
  }
  const where = filters.length === 0 ? undefined : and(...filters);

  const [totals] = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(variants)
    .innerJoin(products, eq(products.key, variants.productKey))
    .leftJoin(pairings, eq(pairings.variantCode, variants.code))
    .where(where);

  const rows = await db
    .select(listColumns)
    .from(variants)
    .innerJoin(products, eq(products.key, variants.productKey))
    .leftJoin(pairings, eq(pairings.variantCode, variants.code))
    .leftJoin(users, eq(users.id, pairings.confirmedBy))
    .where(where)
    .orderBy(asc(variants.code))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);

  return { total: totals?.total ?? 0, items: rows.map(toItem) };
}
