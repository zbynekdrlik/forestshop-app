import type { Page } from "playwright";

/** Zdieľané prihlásenie do Shoptet admina — extrahované z #122's
 * `playwright-import.ts`'s `login()` (issue 123 potrebuje to isté, len na
 * inej nasledujúcej stránke). Žiadna zmena správania #122 — presne ten istý
 * postup, len pod spoločným menom oboch volajúcich. */
export interface AdminLoginConfig {
  readonly loginUrl: string;
  readonly user: string;
  readonly password: string;
}

export async function loginToShoptetAdmin(page: Page, config: AdminLoginConfig): Promise<void> {
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });
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
