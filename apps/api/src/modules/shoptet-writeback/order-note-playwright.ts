import { chromium, type Browser, type Page } from "playwright";
import { log } from "../../logger.js";
import { buildShoptetAdminOrderUrl } from "../orders/queries.js";
import { loginToShoptetAdmin } from "./admin-login.js";
import { DEFAULT_TIMEOUT_MS, runInChildProcess } from "./child-runner.js";
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

// `child-runner.ts`'s DEFAULT_TIMEOUT_MS (5 min) je odvodený z JEDNÉHO CSV
// importu (~30s) — tento beh je NAMIESTO toho SLUČKA cez `options.orders`
// (2 navigácie + fill + save NA OBJEDNÁVKU), takže pri väčšom počte
// čakajúcich poznámok by pevný 5-min strop vedel zabiť beh v polovici a
// stratiť VŠETKY výsledky vrátane už úspešne zapísaných (code review PR
// 315, finding 2 — `run-order-note-writeback.ts`'s `selectChangedOrderNotes`
// nemá žiadny strop na počet, na rozdiel od `restock`'s `MAX_PER_RUN`).
// 20s/objednávku (naživo nameraných ~2-3s proti fixture, štedrá rezerva pre
// reálny Shoptet) + 60s základ (prihlásenie + réžia), nikdy menej než
// zdieľaný default.
const PER_ORDER_TIMEOUT_MS = 20_000;
const BASE_TIMEOUT_MS = 60_000;

function orderNoteTimeoutMs(orderCount: number): number {
  return Math.max(DEFAULT_TIMEOUT_MS, BASE_TIMEOUT_MS + orderCount * PER_ORDER_TIMEOUT_MS);
}

/**
 * Issue 313: rovnaké API/výsledok ako `runOrderNoteWriteback`, ale beh sa
 * deleguje do izolovaného dieťa procesu (`child-runner.ts`, rovnaký dôvod
 * ako `playwright-import.ts`'s `runShoptetImportIsolated`). Toto je
 * funkcia, ktorú má volať `run-order-note-writeback.ts`;
 * `runOrderNoteWriteback` samotné zostáva exportované pre testy proti
 * fixture (aj pre `order-note-worker.ts`, ktorý ho spúšťa VNÚTRI dieťa
 * procesu).
 */
export function runOrderNoteWritebackIsolated(
  options: RunOrderNoteWritebackOptions,
): Promise<readonly OrderNoteWriteResult[]> {
  return runInChildProcess(new URL("./order-note-worker.js", import.meta.url), options, {
    timeoutMs: orderNoteTimeoutMs(options.orders.length),
  });
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
