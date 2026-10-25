// issue 598: zdieľaná detekcia blokovej stránky Shoptetu.
//
// Od 21. 10. 2026 Shoptet WAF (openresty) každé ráno blokuje IP servera
// FClaude a na KAŽDÚ požiadavku na forestshop.sk (verejné stránky, exporty aj
// administráciu) vráti HTTP 403 so stránkou „Access temporarily blocked — Your
// IP address has been temporarily blocked because of suspicious activity that
// looked like an attack" (+ cs/sk preklady v tej istej stránke). Bez rozlíšenia
// sa to prejavovalo ako nezrozumiteľné chyby: restock padal na
// „locator.fill: Timeout … getByPlaceholder('E-mail')", sonda shop-sitemapu
// ticho brala blok ako „kandidát neexistuje" a pokračovala ďalšími stovkami
// požiadaviek. JEDNA detekcia pre všetky fetchery na e-shop (`fetch.ts`) aj
// pre Playwright prihlásenie (`shoptet-writeback/admin-login.ts`).

export const SHOPTET_BLOCKED_CODE = "shoptet_blocked";

// Nadpisy blokovej stránky vo všetkých troch jazykoch, ktoré stránka nesie
// (overené na skutočnej stránke z 25. 10. 2026, `fixtures/shoptet-block-page.html`).
// Stránka sa prepína do jazyka prehliadača cez JS, statický HTML nesie
// anglický text — preklady sú poistka, keby Shoptet poradie otočil.
const BLOCK_PAGE_MARKERS: readonly string[] = [
  "Access temporarily blocked",
  "Přístup dočasně zablokován",
  "Prístup dočasne zablokovaný",
];

/** Blok je VŽDY 403 + jeden z nadpisov blokovej stránky. Bežná 403 (zakázaný
 * export, zlý hash) ani 404 blokom nie sú — tie si volajúci spracuje po svojom. */
export function isShoptetBlockPage(status: number, body: string): boolean {
  if (status !== 403) return false;
  return BLOCK_PAGE_MARKERS.some((marker) => body.includes(marker));
}

export class ShoptetBlockedError extends Error {
  readonly code = SHOPTET_BLOCKED_CODE;

  constructor(context: string) {
    super(
      `${SHOPTET_BLOCKED_CODE}: Shoptet dočasne zablokoval IP adresu servera (HTTP 403 „Access temporarily blocked“) — ${context}. Blok sa zvyčajne sám zruší o niekoľko hodín.`,
    );
    this.name = "ShoptetBlockedError";
  }
}

/** `true` aj pre obyčajný `Error` s rovnakou správou — Playwright prihlásenie
 * beží v dieťa procese (`child-runner.ts`) a chyba k rodičovi prichádza len
 * ako text správy, `instanceof` by ju nepoznal. */
export function isShoptetBlockedError(error: unknown): boolean {
  if (error instanceof ShoptetBlockedError) return true;
  return error instanceof Error && isShoptetBlockedMessage(error.message);
}

/** Pre `job_run.error_message` (čítané z DB, môže byť `null`). */
export function isShoptetBlockedMessage(message: string | null): boolean {
  return message !== null && message.startsWith(`${SHOPTET_BLOCKED_CODE}:`);
}
