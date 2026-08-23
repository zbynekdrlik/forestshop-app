import { asc, count, desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { floorNoteProducts, floorNotes, shopProductUrl, variants } from "../../db/schema.js";

// issue 410: "Eshop → Objednávky predajňa" — čítacia strana. Zoznam nemá
// stránkovanie (na rozdiel od `floor-orders-queries.ts`, ktoré nahrádza) —
// design komentár na ticket-e: najbližší existujúci vzor je `daily_task`
// (issue 342), ktorý tiež načíta VŠETKO naraz, nie stránkovaný zoznam ako
// katalóg/objednávky.
export interface FloorNoteProductRow {
  readonly variantCode: string;
  readonly productName: string;
  readonly sizeLabel: string | null;
  // issue 453: počet kusov k pripnutému produktu (celé číslo ≥ 1). Existujúce
  // riadky majú 1 (stĺpcový `DEFAULT 1` + migrácia).
  readonly quantity: number;
  // Priama adresa z `shop_product_url` (feed/sitemap/probe, `.claude/rules/
  // shop-feed.md` + `shop-sitemap.md`) — `null` keď nie je známa. Frontend
  // (nie tento dopyt) rozhoduje o vizuálne odlíšenom náhradnom odkaze
  // (`ourProductLink`/`isSearchFallback`, design komentár na ticket-e).
  readonly shopUrl: string | null;
}

export interface FloorNoteRow {
  readonly id: string;
  readonly text: string;
  readonly resolved: boolean;
  readonly ordered: boolean;
  readonly called: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly products: readonly FloorNoteProductRow[];
}

export async function listFloorNotes(db: Database): Promise<readonly FloorNoteRow[]> {
  const notes = await db
    .select({
      id: floorNotes.id,
      text: floorNotes.text,
      resolved: floorNotes.resolved,
      ordered: floorNotes.ordered,
      called: floorNotes.called,
      createdAt: floorNotes.createdAt,
      updatedAt: floorNotes.updatedAt,
    })
    .from(floorNotes)
    // Najnovšie hore — zadanie tiketu. `id` je tie-breaker (rovnaký vzor ako
    // `floor-orders-queries.ts`/`catalog/queries.ts`) — `createdAt` samo
    // osebe by pri dvoch zápisoch v TEJ ISTEJ milisekunde bolo
    // nedeterministické.
    .orderBy(desc(floorNotes.createdAt), desc(floorNotes.id));

  if (notes.length === 0) return [];

  const productRows = await db
    .select({
      floorNoteId: floorNoteProducts.floorNoteId,
      variantCode: floorNoteProducts.variantCode,
      productName: variants.name,
      sizeLabel: variants.sizeLabel,
      quantity: floorNoteProducts.quantity,
      shopUrl: shopProductUrl.url,
    })
    .from(floorNoteProducts)
    .innerJoin(variants, eq(variants.code, floorNoteProducts.variantCode))
    .leftJoin(shopProductUrl, eq(shopProductUrl.code, floorNoteProducts.variantCode))
    .orderBy(asc(floorNoteProducts.createdAt), asc(floorNoteProducts.id));

  const byNote = new Map<string, FloorNoteProductRow[]>();
  for (const row of productRows) {
    const list = byNote.get(row.floorNoteId) ?? [];
    list.push({ variantCode: row.variantCode, productName: row.productName, sizeLabel: row.sizeLabel, quantity: row.quantity, shopUrl: row.shopUrl });
    byNote.set(row.floorNoteId, list);
  }

  return notes.map((n) => ({
    id: n.id,
    text: n.text,
    resolved: n.resolved,
    ordered: n.ordered,
    called: n.called,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
    products: byNote.get(n.id) ?? [],
  }));
}

// issue 473: odznak počtu v ľavom menu — počet NEVYBAVENÝCH (`resolved = false`)
// zápisov. GLOBÁLNY (zdieľaný zoznam, žiadny `user_id` filter na čítaní, presne
// ako `listFloorNotes` vyššie). `COUNT(*) WHERE ...` priamo v SQL (rovnaký vzor
// ako `countActionableUpozornenia`). Značky `ordered`/`called` sú NEZÁVISLÉ a do
// počtu NEVSTUPUJÚ — jediné, čo znamená "vybavené", je `resolved` (design
// komentár na issue 410/473).
export async function countUnresolvedFloorNotes(db: Database): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(floorNotes)
    .where(eq(floorNotes.resolved, false));
  return row?.total ?? 0;
}
