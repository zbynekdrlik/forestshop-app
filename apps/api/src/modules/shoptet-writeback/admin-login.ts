import type { Page } from "playwright";
import { log } from "../../logger.js";
import { isShoptetBlockPage, ShoptetBlockedError } from "../shoptet-http/blocked.js";

/** Zdieľané prihlásenie do Shoptet admina — extrahované z #122's
 * `playwright-import.ts`'s `login()` (issue 123 potrebuje to isté, len na
 * inej nasledujúcej stránke). Žiadna zmena správania #122 — presne ten istý
 * postup, len pod spoločným menom oboch volajúcich. */
export interface AdminLoginConfig {
  readonly loginUrl: string;
  readonly user: string;
  readonly password: string;
}

/**
 * Volá sa pri zlyhaní po prihlásení: otvorená bloková stránka je skutočná príčina,
 * nie chýbajúci prvok. Bez nej by restock nedostal predponu `shoptet_blocked:` a
 * nenaplánoval opakovanie. Status poslednej navigácie tu nie je k dispozícii, preto
 * sa rozhoduje podľa textu stránky.
 */
export async function throwIfShoptetBlockPage(page: Page): Promise<void> {
  const html = await page.content().catch((error: unknown) => {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.warn({ rawErrorMessage }, "shoptet admin: stránku sa po zlyhaní nedalo prečítať");
    return "";
  });
  if (isShoptetBlockPage(403, html)) throw new ShoptetBlockedError("relácia v Shoptet administrácii");
}

export async function loginToShoptetAdmin(page: Page, config: AdminLoginConfig): Promise<void> {
  const response = await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });
  // issue 598: Shoptet WAF od 21. 10. 2026 každé ráno vráti namiesto
  // prihlasovacej stránky blokovú stránku (403) — bez tejto kontroly to padalo
  // až o 30 s neskôr na nezrozumiteľnom „locator.fill: Timeout … E-mail".
  // Chyba sa k rodičovi dostáva cez IPC len ako TEXT správy, preto ju
  // `isShoptetBlockedError` (`shoptet-http/blocked.ts`) rozpozná podľa predpony.
  // Blok, čo začne až uprostred relácie, rieši `throwIfShoptetBlockPage`.
  if (response !== null && response.status() === 403) {
    const body = await response.text().catch((error: unknown) => {
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      log.warn({ rawErrorMessage }, "shoptet admin: telo 403 prihlasovacej stránky sa nedalo prečítať");
      return "";
    });
    if (isShoptetBlockPage(403, body)) throw new ShoptetBlockedError("prihlásenie do Shoptet administrácie");
  }
  await page.getByPlaceholder("E-mail").fill(config.user);
  await page.getByPlaceholder("Vaše heslo").fill(config.password);
  await page.getByRole("button", { name: "Prihlásenie" }).click();
  await page.waitForLoadState("networkidle");
  // NIKDY substring na URL ("/login") — reálny Shoptet login pre tento obchod
  // je na `${adminBaseUrl}/admin/` a úspešné prihlásenie sa vráti na TÚ ISTÚ
  // URL (overené naživo pri návrhu #122). Jediný spoľahlivý signál zlyhania
  // je, že prihlasovací formulár je STÁLE na stránke.
  if ((await page.getByPlaceholder("E-mail").count()) > 0) {
    throw new Error("Prihlásenie do Shoptetu zlyhalo (prihlasovací formulár stále viditeľný) — over SHOPTET_ADMIN_USER/PASSWORD");
  }
}
