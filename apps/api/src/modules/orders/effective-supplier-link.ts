import { sql, type SQL } from "drizzle-orm";
import { pairingDecisions, pairingVariantLinks, products, productSupplierLinkOverrides } from "../../db/schema.js";
import { extractSupplierLink, type SupplierLink } from "../catalog/supplier-link.js";

// issue 121: efektívny odkaz na dodávateľa riadku — manažérovo ručné
// prepísanie (`product_supplier_link_override`), a keď žiadne nie je,
// odkaz extrahovaný z katalógového `product.internalNote`
// (`extractSupplierLink`). Priamy náprotivok `supplier-key.ts`'s
// `effectiveSupplierSql` (dodávateľ MENO), len tu je "extrakcia" čistá JS
// funkcia (regex nad voľným textom), nie SQL výraz — coalesce preto beží
// AŽ TU, po tom, čo obe strany (override stĺpec + `internalNote`) prídu z
// DB. NA ROZDIEL od `effectiveSupplierSql` je toto prepísanie VŽDY
// prioritné (nikdy podmienené tým, či Shoptet niečo má) — ticket to žiada
// explicitne, majiteľ opravuje aj EXISTUJÚCE odkazy, nielen dopĺňa chýbajúce.
// Použité na VŠETKÝCH troch čítacích cestách, ktoré dnes zobrazujú odkaz na
// dodávateľa (`queries.ts`'s `listOpenOrderLinesBySupplier` + `getOrderDetail`,
// `mail.ts`'s `loadOutstandingLines`) — rovnaká disciplína ako
// `effectiveSupplierSql`'s komentár žiada pre dodávateľa MENO.
export function resolveEffectiveSupplierLink(
  internalNote: string | null,
  overrideUrl: string | null,
): SupplierLink {
  const extracted = extractSupplierLink(internalNote);
  if (overrideUrl !== null) return { url: overrideUrl, note: extracted.note };
  return extracted;
}

// issue 565: SQL náprotivok `resolveEffectiveSupplierLink` (+ issue 423 split
// vetva) pre MNOŽINOVÉ dopyty, kde sa efektívny odkaz musí počítať priamo v SQL
// a nedá sa nahradiť čítaním do JS bez rozbitia dopytu na N dotazov
// (`restock/queries.ts` kandidátsky výber). JEDINÁ definícia poradia efektívneho
// odkazu na SQL strane — každý budúci množinový konzument importuje toto, nie
// vlastnú kópiu coalesce (pred týmto reštok SQL ignoroval override a rozišiel sa
// s `collectSupplierLinks` — `supplier-stock/run.ts`).
//
// Poradie ZHODNÉ s `collectSupplierLinks`/`resolveEffectiveSupplierLink`:
//   1. split per-veľkosť linka (`pairing_variant_link.url`) — LEN keď je produkt
//      `pairing_decision.status='split'`; dormantná per-veľkosť linka sa ignoruje;
//   2. `product_supplier_link_override.url` — manažérov ručný odkaz z Vyhľadať
//      (issue 239/240), braný DOSLOVNE (bez extrakcie/orezania), presne ako ho
//      `collectSupplierLinks` zapíše do kľúča `supplier_stock.link`;
//   3. prvá `http(s)://…` URL z `product.internal_note`.
// Split linka aj `internal_note` sa extrahujú tým istým `substring`+orezaním
// koncovej interpunkcie ako scraper (`supplier-link.ts`), aby sa kľúč na
// `supplier_stock` nemohol rozísť. Override sa NEorezáva — je to čistá URL, nie
// voľný text (rovnaké rozhodnutie ako `resolveEffectiveSupplierLink`).
//
// Tabuľky, na ktoré fragment odkazuje (`pairing_decision`, `pairing_variant_link`,
// `product_supplier_link_override`, `product`), musia byť v JOIN zozname dopytu
// PRED miestom použitia (v `restock` ON klauzule `supplier_stock` innerJoinu).
const productLinkSql = sql<string>`trim(both from regexp_replace(substring(${products.internalNote} from 'https?://[^[:space:]]+'), '[.,;:)\\]]+$', ''))`;
const variantLinkSql = sql<string>`trim(both from regexp_replace(substring(${pairingVariantLinks.url} from 'https?://[^[:space:]]+'), '[.,;:)\\]]+$', ''))`;
export const effectiveSupplierLinkSql: SQL<string> = sql`coalesce(case when ${pairingDecisions.status} = 'split' then ${variantLinkSql} end, ${productSupplierLinkOverrides.url}, ${productLinkSql})`;
