import { chromium, type Browser, type Page } from "playwright";
import { log } from "../../logger.js";
import { buildShoptetAdminOrderUrl } from "../orders/queries.js";
import { loginToShoptetAdmin } from "./admin-login.js";
import type { OrderNoteWritebackConfig } from "./config.js";
import { mergeShopRemark } from "./note-block.js";
import type { OrderNoteToSync } from "./order-note-select.js";
import { resolveChromiumExecutablePath } from "./playwright-import.js";

export interface OrderNoteWriteResult {
  readonly orderId: string;
  readonly externalOrderId: string;
  readonly ok: boolean;
  readonly errorDetail: string | null;
}

export interface RunOrderNoteWritebackOptions {
  readonly config: OrderNoteWritebackConfig;
  readonly orders: readonly OrderNoteToSync[];
  readonly headless?: boolean;
  readonly executablePath?: string;
}

/**
 * Issue 123: pre KAŽDÚ objednávku otvorí jej detail (priamy odkaz,
 * `buildShoptetAdminOrderUrl` — každá tu má `shoptetOrderId`, `order-note-
 * select.ts` už tie bez neho vylúčilo), zlúči aktuálny obsah `textarea
 * [name=shopRemark]` s appkinou poznámkou (`mergeShopRemark`), uloží (`data-
 * testid=buttonSaveAndStay`) a overí ČERSTVOU navigáciou, že sa zápis
 * skutočne uplatnil na strane Shoptetu (nikdy len že sa klik odoslal) —
 * naživo overený tvar stránky pri návrhu tohto ticketu.
 *
 * JEDNA prihlásená browser session pre CELÝ zoznam (rovnaký vzor ako #122's
 * `runShoptetImport` — jedno prihlásenie, nie jedno na objednávku). Na
 * rozdiel od #122 (jeden hromadný CSV import, všetko alebo nič) zlyhanie NA
 * JEDNEJ objednávke NEPRERUŠÍ zvyšok zoznamu — pokračuje ďalšou, aby jedna
 * zlá objednávka nezablokovala úspešný zápis ostatných (`run-order-note-
 * writeback.ts` označí ako synchronizované LEN tie, čo tu vyšli `ok`).
 */
export async function runOrderNoteWriteback(
  options: RunOrderNoteWritebackOptions,
): Promise<readonly OrderNoteWriteResult[]> {
  const { config, orders } = options;
  const executablePath = options.executablePath ?? resolveChromiumExecutablePath();
  let browser: Browser | undefined;
  const results: OrderNoteWriteResult[] = [];
  try {
    browser = await chromium.launch({
      headless: options.headless ?? true,
      ...(executablePath === undefined ? {} : { executablePath }),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    await loginToShoptetAdmin(page, config);

    for (const order of orders) {
      results.push(await writeOneOrderNote(page, config.adminBaseUrl, order));
    }
  } finally {
    await browser?.close();
  }
  return results;
}

async function writeOneOrderNote(
  page: Page,
  adminBaseUrl: string,
  order: OrderNoteToSync,
): Promise<OrderNoteWriteResult> {
  const url = buildShoptetAdminOrderUrl(adminBaseUrl, order.externalOrderId, order.shoptetOrderId);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    const textarea = page.locator('textarea[name="shopRemark"]');
    if ((await textarea.count()) === 0) {
      throw new Error(`Nenašiel som pole "Poznámka e-shopu" (textarea[name=shopRemark]) na ${page.url()}`);
    }
    const existing = await textarea.inputValue();
    const merged = mergeShopRemark(existing, order.comment);
    await textarea.fill(merged);

    const saveButton = page.getByTestId("buttonSaveAndStay");
    if ((await saveButton.count()) === 0) {
      throw new Error(`Nenašiel som tlačidlo "Uložiť" (data-testid=buttonSaveAndStay) na ${page.url()}`);
    }
    await saveButton.click();
    await page.waitForLoadState("networkidle");

    // Read-back cez ČERSTVÚ navigáciu (nie len DOM stav hneď po uložení) —
    // potvrdzuje SERVER-side hodnotu, presne ako #122's Log-based overenie
    // výsledku importu, nikdy len "klik prešiel bez chyby".
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    const confirmed = await page.locator('textarea[name="shopRemark"]').inputValue();
    if (confirmed !== merged) {
      throw new Error(
        `Zápis poznámky sa po čerstvej navigácii nepotvrdil (očakávaných ${String(merged.length)} znakov, prečítaných ${String(confirmed.length)})`,
      );
    }

    log.info(
      { externalOrderId: order.externalOrderId, shoptetOrderId: order.shoptetOrderId },
      "spätný zápis poznámky objednávky: úspech",
    );
    return { orderId: order.orderId, externalOrderId: order.externalOrderId, ok: true, errorDetail: null };
  } catch (error) {
    const errorDetail = error instanceof Error ? error.message : String(error);
    log.error(
      { externalOrderId: order.externalOrderId, shoptetOrderId: order.shoptetOrderId, errorDetail },
      "spätný zápis poznámky objednávky: zlyhanie",
    );
    return { orderId: order.orderId, externalOrderId: order.externalOrderId, ok: false, errorDetail };
  }
}
