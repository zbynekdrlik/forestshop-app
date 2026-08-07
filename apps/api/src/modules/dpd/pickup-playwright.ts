import { chromium, type Browser } from "playwright";
import { log } from "../../logger.js";
import { resolveChromiumExecutablePath } from "../shoptet-writeback/playwright-import.js";
import { runInChildProcess } from "../shoptet-writeback/child-runner.js";
import { loginToDpdPortal } from "./login.js";
import type { DpdPortalConfig } from "./config.js";

// issue 292: "Objednávky zvozu" (`/pickup-orders`) — naživo overené
// (7.8.2026): stránka má "Pravidelný zvoz" + "Jednorazové zvozy" so `+`
// tlačidlom na pridanie NOVÉHO jednorazového zvozu. Samotný formulár, ktorý
// sa po kliku na `+` otvorí, NIE JE naživo domapovaný (rovnaký dôvod ako
// `shipment-playwright.ts`'s `fillShipmentFields` — čaká sa na
// `DPD_PORTAL_USER`/`PASSWORD`). Rovnaká disciplína: zlyhaj NAHLAS, nikdy
// tichy odošli vymyslené polia.
const PICKUP_ORDERS_PATH = "/pickup-orders";

function fillPickupForm(): never {
  throw new Error(
    "DPD formulár jednorazového zvozu (/pickup-orders) ešte nie je naživo domapovaný (čaká sa na DPD_PORTAL_USER/PASSWORD) — " +
      "zvoz sa neobjednal. Pozri issue 292, fillPickupForm v pickup-playwright.ts.",
  );
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
    await page.goto(`${new URL(options.config.loginUrl).origin}${PICKUP_ORDERS_PATH}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    fillPickupForm();

    return { ok: false, errorDetail: "unreachable" };
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
