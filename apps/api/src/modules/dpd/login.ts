import type { Page } from "playwright";
import type { DpdPortalConfig } from "./config.js";

/**
 * Prihlásenie do `dpdshipper.sk` — naživo overené (7.8.2026, read-only
 * mapovanie, `dpd-mapuj.mjs` v `.claude/rules/dpd.md`'s prieskume): jedno
 * meno + jedno heslo, žiadna CAPTCHA, žiadne 2FA, žiadna ochrana proti
 * robotom. Úspešné prihlásenie skončí na `/shipments` — na rozdiel od
 * Shoptet admina (kde úspech aj zlyhanie zdieľajú tú istú URL,
 * `shoptet-writeback/admin-login.ts`) tu je presmerovanie spoľahlivý signál,
 * ale appka NAVYŠE overuje, že prihlasovacie pole zmizlo (rovnaká dvojitá
 * istota ako Shoptet — nikdy sa nespolieha len na URL substring).
 */
export async function loginToDpdPortal(page: Page, config: DpdPortalConfig): Promise<void> {
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });
  await page.locator("input[name=loginName], #loginName").first().fill(config.user);
  await page.locator("input[type=password]").first().fill(config.password);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {
      // networkidle nemusí nikdy nastať (dlho bežiace polling volania na
      // portáli) — appka sa spolieha na explicitné overenie nižšie, nie na
      // toto čakanie samotné.
    }),
    page.locator("button:has-text('Prihlásiť'), input[type=submit]").first().click(),
  ]);
  if ((await page.locator("input[name=loginName], #loginName").count()) > 0) {
    throw new Error("Prihlásenie do DPD portálu zlyhalo (prihlasovací formulár stále viditeľný) — over DPD_PORTAL_USER/PASSWORD");
  }
}
