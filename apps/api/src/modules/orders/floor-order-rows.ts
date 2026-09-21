import { desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  floorNoteProducts,
  floorNotes,
  productSupplierLinkOverrides,
  productSupplierOverrides,
  products,
  shopProductUrl,
  variants,
} from "../../db/schema.js";
import { resolveEffectiveSupplierLink } from "./effective-supplier-link.js";
import type { FloorOrderRow } from "./queries.js";
import { effectiveSupplierSql } from "./supplier-key.js";

// issue 480/575: predajňové riadky pre board „Na objednanie" — produkty pripnuté
// na NEVYBAVENÝCH zápisoch (`floor_note.resolved = false`) s efektívnym
// dodávateľom + odkazmi + stavom + poznámkou počítanými TOU ISTOU cestou ako
// `order_line`. Vyňaté z `queries.ts` (eslint `max-lines: 400`, `.claude/rules/
// frontend-design.md`/`testing.md` extrakčný vzor) — `queries.ts` ho volá.
// Zámerne SAMOSTATNÝ dopyt (nie JOIN na hlavný riadkový), keďže floor riadky sa
// zoskupujú per dodávateľ AŽ v JS spolu s riadkami objednávok. Zoradené
// najnovšie-prvé (zhodne s hlavným dopytom). Vracia `effectiveSupplier` ako
// surový reťazec (`null` = bez dodávateľa) — normalizáciu rieši volajúci.
export async function listUnresolvedFloorOrderRows(
  db: Pick<Database, "select">,
): Promise<readonly (FloorOrderRow & { readonly effectiveSupplier: string | null })[]> {
  const rows = await db
    .select({
      noteId: floorNoteProducts.floorNoteId,
      noteText: floorNotes.text,
      noteCreatedAt: floorNotes.createdAt,
      variantCode: floorNoteProducts.variantCode,
      // issue 575: `product.key` + efektívny odkaz na dodávateľa TOU ISTOU
      // cestou ako order line (`resolveEffectiveSupplierLink` nad
      // `products.internal_note` + `product_supplier_link_override`) + naša
      // adresa (`shop_product_url` leftJoin na variantCode) + stav + poznámka.
      productKey: products.key,
      productName: variants.name,
      sizeLabel: variants.sizeLabel,
      quantity: floorNoteProducts.quantity,
      orderedAt: floorNoteProducts.orderedAt,
      state: floorNoteProducts.state,
      comment: floorNoteProducts.comment,
      internalNote: products.internalNote,
      supplierLinkOverride: productSupplierLinkOverrides.url,
      ourUrl: shopProductUrl.url,
      effectiveSupplier: effectiveSupplierSql,
    })
    .from(floorNoteProducts)
    .innerJoin(floorNotes, eq(floorNotes.id, floorNoteProducts.floorNoteId))
    .innerJoin(variants, eq(variants.code, floorNoteProducts.variantCode))
    .innerJoin(products, eq(products.key, variants.productKey))
    .leftJoin(productSupplierOverrides, eq(productSupplierOverrides.productKey, products.key))
    .leftJoin(productSupplierLinkOverrides, eq(productSupplierLinkOverrides.productKey, products.key))
    // issue 575: LEFT (ako order line, issue 276) — variant bez záznamu vo
    // feede NESMIE zo zoznamu vypadnúť, len jeho kód sa vykreslí ako neaktívny.
    .leftJoin(shopProductUrl, eq(shopProductUrl.code, floorNoteProducts.variantCode))
    .where(eq(floorNotes.resolved, false))
    .orderBy(desc(floorNotes.createdAt), desc(floorNoteProducts.id));

  return rows.map((row) => {
    // issue 575: TÁ ISTÁ efektívna cesta odkazu na dodávateľa ako order line.
    const supplierLink = resolveEffectiveSupplierLink(row.internalNote, row.supplierLinkOverride);
    return {
      noteId: row.noteId,
      variantCode: row.variantCode,
      productKey: row.productKey,
      productName: row.productName,
      sizeLabel: row.sizeLabel,
      // Meno zákazníka = prvý riadok textu zápisu, orezaný (zadanie klienta).
      customerName: (row.noteText.split(/\r?\n/)[0] ?? "").trim(),
      quantity: row.quantity,
      ourUrl: row.ourUrl,
      supplierUrl: supplierLink.url,
      supplierNote: supplierLink.note,
      state: row.state,
      comment: row.comment,
      createdAt: row.noteCreatedAt.toISOString(),
      ordered: row.orderedAt !== null,
      effectiveSupplier: row.effectiveSupplier,
    };
  });
}
