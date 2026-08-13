// issue 422 — živá cena+dostupnosť z JSON-LD `Offer` na detailnej stránke
// kandidáta. Zdieľané WETLAND aj ODIMON adaptérom (`wetland.ts`/`odimon.ts`)
// — obe domény nesú `<script type="application/ld+json">` s platnou `Offer`
// (živo overené 13. 8. 2026, design komentár na tickete): WETLAND
// `price: "149.9"`/`availability: "https://schema.org/BackOrder"`, ODIMON
// `price: "78.90"`/`"http://schema.org/InStock"`. BETALOV (huntingshop.eu)
// NEMÁ žiadne JSON-LD ani `og:price`/`og:availability` meta značky vôbec
// (živo overené) — jeho vlastná extrakcia (`var prodData = {...}` JS
// premenná) žije priamo v `betalov.ts`, nie tu.
//
// Znovupoužíva `supplier-stock/parse.ts`'s `fromJsonLd` (issue 212/213's už
// otestovaná JSON-LD extrakcia) namiesto vlastného regexu — DRY, a
// spoľahlivejšie než stará appka's holý `_supplier_meta` regex (ktorý
// nevedel obe poradia `property=`/`content=` atribútov). Táto funkcia
// ZÁMERNE nejde cez `parsePage()` (rovnaký modul) — ten má fail-closed
// "neznáma doména" bránu navrhnutú pre AUTOMATICKÉ prepínanie Vypredané→
// Skladom (bezpečnostná brána nad zápisom do Shoptetu), nevhodnú pre tento
// čisto INFORMATÍVNY náhľad pre reviewera (design komentár na tickete).

import { fromJsonLd } from "../../supplier-stock/parse.js";
import type { SupplierDetailMeta } from "./types.js";

const AVAILABILITY_LABELS: Readonly<Record<"available" | "unavailable" | "unknown", string | null>> = {
  available: "Skladom",
  unavailable: "Nedostupné",
  unknown: null,
};

/** Zdieľaná JSON-LD `Offer` extrakcia — WETLAND aj ODIMON. Nikdy nevyhadzuje. */
export function jsonLdSupplierDetailMeta(html: string): SupplierDetailMeta {
  const hit = fromJsonLd(html);
  if (hit === null) return { price: null, availabilityText: null };
  return {
    price: hit.price !== null && Number.isFinite(hit.price) ? hit.price.toFixed(2) : null,
    availabilityText: AVAILABILITY_LABELS[hit.availability],
  };
}
