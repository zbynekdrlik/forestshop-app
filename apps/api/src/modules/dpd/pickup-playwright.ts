import { chromium, type Browser, type Page } from "playwright";
import { log } from "../../logger.js";
import { resolveChromiumExecutablePath } from "../shoptet-writeback/playwright-import.js";
import { runInChildProcess } from "../shoptet-writeback/child-runner.js";
import { loginToDpdPortal } from "./login.js";
import type { DpdPortalConfig } from "./config.js";
import { typeInto } from "./portal-fill.js";

// issue 292: "Objednávky zvozu" (`/pickup-orders`) — naživo overené
// (7.8.2026 menu, 9.8.2026 formulár): klik "+" pri "Jednorazové zvozy"
// navigoval na `/pickup-orders/0` (`config.ts`'s `newPickupOrderUrl`), teda
// priama navigácia je spoľahlivejšia než hľadanie tlačidla. Formulár je
// DVOJKROKOVÝ — krok 1 (zvozová adresa/kontakt/dátum, predvyplnené z účtu,
// appka mení LEN dátum) → "Pokračovať" → krok 2 (rovnaká URL, appka's
// vlastný SPA prechod) → skutočné "Uložiť".
const PICKUP_DATE_SELECTOR = '#pickup-date input[wj-part="input"]';
const CONTINUE_BUTTON_SELECTOR = "#button-confirmation";

/** DPD portál čaká slovenský tvar dátumu bez vedúcich núl ("10. 8. 2026"),
 * naživo overené (9.8.2026) — appka dostáva ISO `YYYY-MM-DD`
 * (`http/dpd-routes.ts`'s `pickupBody` validácia). */
function toDpdDateFormat(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) throw new Error(`DPD zvoz: neplatný dátum "${isoDate}" (očakávané YYYY-MM-DD)`);
  const year = match[1] ?? "";
  const month = match[2] ?? "";
  const day = match[3] ?? "";
  return `${String(Number(day))}. ${String(Number(month))}. ${year}`;
}

async function fillPickupForm(page: Page, pickupDate: string): Promise<void> {
  await typeInto(page, PICKUP_DATE_SELECTOR, toDpdDateFormat(pickupDate));
  await page.locator(CONTINUE_BUTTON_SELECTOR).click();
  await page.waitForTimeout(1000);

  const saveButton = page.getByRole("button", { name: "Uložiť", exact: true });
  await saveButton.click();
  await page.waitForTimeout(1000);

  // Presný úspešný signál sa nedal naživo overiť (prvý reálny klik patrí
  // majiteľovi, issue 292) — appka preto aspoň overí, že sa NEOBJAVILA
  // viditeľná chybová správa, namiesto tichého predpokladu úspechu.
  const errorText = await page
    .locator('.toast-error, .alert-danger, [class*="error"]:visible')
    .first()
    .textContent({ timeout: 2000 })
    .catch(() => null);
  if (errorText !== null && errorText.trim() !== "") {
    throw new Error(`DPD portál nahlásil chybu pri objednaní zvozu: ${errorText.trim()}`);
  }
}

export interface RunOrderDpdPickupOptions {
  readonly config: DpdPortalConfig;
  readonly pickupDate: string;
  readonly headless?: boolean;
  readonly executablePath?: string;
}

export interface OrderDpdPickupOutcome {
  readonly ok: boolean;
  readonly errorDetail: string | null;
}

export async function runOrderDpdPickup(options: RunOrderDpdPickupOptions): Promise<OrderDpdPickupOutcome> {
  const executablePath = options.executablePath ?? resolveChromiumExecutablePath();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: options.headless ?? true,
      ...(executablePath === undefined ? {} : { executablePath }),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();

    await loginToDpdPortal(page, options.config);
    await page.goto(options.config.newPickupOrderUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    await fillPickupForm(page, options.pickupDate);
    return { ok: true, errorDetail: null };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message, pickupDate: options.pickupDate }, "DPD zvoz: pokus zlyhal");
    return { ok: false, errorDetail: message };
  } finally {
    await browser?.close();
  }
}

export type OrderPickupWorkerInput = RunOrderDpdPickupOptions;

export function runOrderDpdPickupIsolated(options: RunOrderDpdPickupOptions): Promise<OrderDpdPickupOutcome> {
  return runInChildProcess(new URL("./pickup-worker.js", import.meta.url), options);
}
