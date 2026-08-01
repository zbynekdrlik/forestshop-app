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
