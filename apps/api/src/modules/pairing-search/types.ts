// Typy jadra párovacieho vyhľadávania (issue 387 E1) — adaptácia starej
// appka's `parovanie/models.py` `Product`/`Candidate` na katalógový model
// tejto appky. Návrh (https://github.com/zbynekdrlik/forestshop-app/
// issues/387#issuecomment-5273377438, sekcia „Čo sa adaptuje"): jednotka
// párovania je PRODUKT (`product.key` = guid) s variantmi pod ním —
// nahrádza starý (supplier, pairCode|meno) grouping z CSV. `external_code`
// je u nás per-VARIANT (na rozdiel od starej appky, kde bol jeden na
// zoskupený produkt), takže `PairingProduct.externalCodes` nesie VŠETKY
// odlišné, neprázdne kódy naprieč variantmi produktu — silnejšie než starý
// „prvý neprázdny".

/** Vstupný riadok z `products` tabuľky, potrebný pre adaptér nižšie. */
export interface CatalogProductRow {
  readonly key: string;
  readonly name: string;
  readonly supplier: string | null;
}

/** Vstupný riadok z `variants` tabuľky, potrebný pre adaptér nižšie. */
export interface CatalogVariantRow {
  readonly externalCode: string | null;
}

/** Produkt pripravený pre `queries.ts`/`ranking.ts` — čistá dátová štruktúra. */
export interface PairingProduct {
  readonly productKey: string;
  readonly name: string;
  readonly supplier: string | null;
  readonly externalCodes: readonly string[];
}

/**
 * Kandidát z vyhľadávania u dodávateľa — port `models.py`'s `Candidate`.
 * `rawScore`/`codeHit` sú diagnostické polia, ktoré dopĺňa `ranking.ts`'s
 * `rank()` (a zodpovedajú `pairing_candidate`'s `raw_score`/`code_hit`
 * stĺpcom z návrhu, sekcia „DB schéma" — pripravené na E3).
 *
 * `imageUrl` (issue 397, MIMO doslovného portu — stará appka obrázok
 * kandidáta z výsledkovej karty nikdy neparsovala, ťahala ho až naživo z
 * detailu pri otvorení webreview) — adaptéry ho čítajú priamo z výsledkovej
 * karty (`adapters/url.ts`'s `resolveImageUrl`), `verify.ts` ho pri overení
 * kódu vie doplniť z `og:image` detailu ako fallback (LEN pre chosen
 * kandidáta, viď design komentár na tickete).
 */
export interface PairingCandidate {
  readonly name: string;
  readonly url: string;
  readonly code: string | null;
  readonly price: string | null;
  readonly imageUrl: string | null;
  readonly rawScore: number;
  readonly codeHit: boolean;
}

/** Istota návrhu — port `models.py`'s `Match.confidence` reťazcových hodnôt. */
export type PairingConfidence = "high" | "medium" | "low" | "none";

/**
 * Výsledok kódového overenia (issue 387 E4, port `verify.py`'s
 * `code_verdict`) — `ok` = kód produktu bol nájdený na stránke kandidáta,
 * `unsure` = nenašiel sa (alebo produkt nemá žiadny kód na overenie, alebo
 * sa stránku nepodarilo stiahnuť). Overenie NIKDY nevráti "false-ok" —
 * chýbajúci dôkaz vždy znamená `unsure`, nikdy `ok`.
 */
export type PairingVerdict = "ok" | "unsure";

/**
 * Adaptér: (produkt, jeho varianty) → `PairingProduct`. Deduplikuje
 * `externalCode`, zahadzuje prázdne/`null` hodnoty, zachováva poradie
 * prvého výskytu (rovnaká disciplína ako `queries.ts`'s dedup).
 */
export function toPairingProduct(
  product: CatalogProductRow,
  variants: readonly CatalogVariantRow[],
): PairingProduct {
  const seen = new Set<string>();
  const externalCodes: string[] = [];
  for (const variant of variants) {
    const code = variant.externalCode?.trim();
    if (code && !seen.has(code)) {
      seen.add(code);
      externalCodes.push(code);
    }
  }
  return {
    productKey: product.key,
    name: product.name,
    supplier: product.supplier,
    externalCodes,
  };
}
