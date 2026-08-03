// issue 213: "Vypredané → Skladom" — automatické zapínanie produktov, ktoré
// dodávateľ zase má skladom.

export const RESTOCK_JOB_NAME = "restock";
export const RESTOCK_SETTINGS_ID = "default";

// Vlastný advisory zámok (`.claude/rules/scheduler.md`) — job má manuálny
// trigger na tú istú prácu ako nočný beh, takže dva prekrývajúce sa behy by
// mohli poslať ten istý produkt do Shoptetu dvakrát.
export const RESTOCK_RUN_LOCK_KEY = 787_878_008;

// Rozhodnutie majiteľa (3. 8. 2026): najviac 50 prepnutí za jeden beh, zvyšok
// počká na ďalšiu noc. Zámerne konzervatívne — naposledy nameraných 767
// vypredaných viditeľných variantov s dodávateľskou linkou, takže bez stropu
// by prvá noc mohla preklopiť stovky produktov naraz.
export const MAX_PER_RUN = 50;

// Ako staré smie byť potvrdenie dodávateľa, aby sa naň dalo prepnúť. Scraper
// (issue 212) kontroluje každý odkaz aspoň raz denne, takže čerstvé
// potvrdenie je hlboko pod touto hranicou; čokoľvek staršie je dohad.
export const CONFIRMATION_MAX_AGE_HOURS = 48;

// Viditeľnosť, pri ktorej sa produkt SMIE zapnúť. Čokoľvek iné — `detailOnly`
// (na reálnom exporte 5 276 riadkov, z toho 526 vyzerá ako obyčajné
// vypredané), `hidden`, `blocked`, `cashDeskOnly`, `blockUnregistered` — je
// VEDOMÉ rozhodnutie majiteľa produkt nepredávať a automatizácia ho nikdy
// neprebije.
export const SELLABLE_VISIBILITY = "visible";

// Text, ktorý Shoptet zobrazuje zákazníkovi. Musí sa zapísať do OBOCH polí
// naraz — Shoptet ukazuje `availabilityOutOfStock` v momente, keď sklad
// klesne na nulu, takže zápis len do `availabilityInStock` by po dopredaní
// fiktívnych kusov vrátil staré „Vypredané" (overené v ostrej prevádzke
// starej appky 14. 7. 2026).
export const AVAILABILITY_IN_STOCK_TEXT = "Skladom";

// Fiktívny sklad, ktorý produkt vráti do predaja. Kladné číslo je nutné —
// pri nule Shoptet zobrazí `availabilityOutOfStock` a prepnutie by nemalo
// žiadny efekt.
export const RESTOCK_STOCK = 10;
