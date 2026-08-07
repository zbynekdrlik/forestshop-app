import { chromium, type Browser } from "playwright";
import { log } from "../../logger.js";
import { resolveChromiumExecutablePath } from "../shoptet-writeback/playwright-import.js";
import { runInChildProcess } from "../shoptet-writeback/child-runner.js";
import { loginToDpdPortal } from "./login.js";
import type { DpdPortalConfig } from "./config.js";
import type { DpdShipmentPreview } from "./preview.js";

/**
 * issue 292: Playwright robot na `dpdshipper.sk` — rovnaký izolovaný
 * dieťa-proces vzor ako `shoptet-writeback` (issue 313, `.claude/rules/
 * shoptet-writeback.md`: appka's vlastný dlho bežiaci proces nedrží
 * `.fill()` hodnotu spoľahlivo). Prihlásenie (`login.ts`) je naživo
 * OVERENÉ (7.8.2026, read-only mapovanie). Navigácia na formulár
 * (`/shipments/0`) je naživo overená TIEŽ (rovnaké mapovanie).
 *
 * **Vyplnenie SAMOTNÝCH POLÍ formulára (`fillShipmentFields` nižšie) NIE JE
 * naživo domapované** — Importné profily (hromadný súborový import, plán A)
 * boli na účte prázdne a jediný spôsob zistiť ich formát je ZALOŽIŤ profil,
 * čo je ZÁPIS a bezpečnostné pravidlo tohto tiketu ho zakazuje; samotný
 * formulár `/shipments/0` zase vyžaduje prihlásenie, na ktoré appka čaká
 * (`DPD_PORTAL_USER`/`PASSWORD`, issue 292's komentár). Táto funkcia preto
 * zlyhá NAHLAS s presným, akčným popisom namiesto TICHÉHO odoslania
 * vymyslených/nesprávnych polí do formulára — presne rovnaká disciplína ako
 * `shoptet-writeback/playwright-import.ts`'s `ensureSafeSettings` (radšej
 * nahlas zlyhať, než odoslať niečo neisté). Prvé použitie po naživo
 * domapovaní nahradí LEN telo tejto jednej funkcie, zvyšok (prihlásenie,
 * navigácia, chybové hlásenia, izolovaný dieťa-proces vzor) sa nemení.
 */
function fillShipmentFields(): never {
  throw new Error(
    "DPD formulár /shipments/0 ešte nie je naživo domapovaný (čaká sa na DPD_PORTAL_USER/PASSWORD) — " +
      "žiadna zásielka sa neodoslala. Pozri issue 292, fillShipmentFields v shipment-playwright.ts.",
  );
}

export interface RunCreateDpdShipmentOptions {
  readonly config: DpdPortalConfig;
  readonly shipment: DpdShipmentPreview;
  readonly headless?: boolean;
  readonly executablePath?: string;
}

export interface CreateDpdShipmentOutcome {
  readonly ok: boolean;
  readonly parcelNumber: string | null;
  readonly errorDetail: string | null;
}

export async function runCreateDpdShipment(options: RunCreateDpdShipmentOptions): Promise<CreateDpdShipmentOutcome> {
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
    await page.goto(options.config.newShipmentUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    fillShipmentFields();

    // Nedosiahnuteľné, kým `fillShipmentFields` vyššie hádže — ponechané
    // ako jasný kontrakt pre dokončenie po naživo domapovaní (submit +
    // čítanie čísla zásielky z výsledkovej stránky, rovnaký princíp ako
    // `shoptet-writeback/log-attribution.ts`'s `pollForResult`).
    return { ok: false, parcelNumber: null, errorDetail: "unreachable" };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message, externalOrderId: options.shipment.externalOrderId }, "DPD zásielka: pokus zlyhal");
    return { ok: false, parcelNumber: null, errorDetail: message };
  } finally {
    await browser?.close();
  }
}

/** Cez IPC ide `shipment` ako obyčajný JSON objekt (žiadny `Buffer`, na
 * rozdiel od `shoptet-writeback/playwright-import.ts`'s CSV) — netreba
 * base64 kódovanie. */
export type CreateShipmentWorkerInput = RunCreateDpdShipmentOptions;

/**
 * Rovnaký zámer ako `shoptet-writeback/playwright-import.ts`'s
 * `runShoptetImportIsolated` — appka's vlastný bežiaci proces Chromium
 * NIKDY sám nespúšťa, vždy cez krátko žijúce dieťa (`child-runner.ts`).
 */
export function runCreateDpdShipmentIsolated(options: RunCreateDpdShipmentOptions): Promise<CreateDpdShipmentOutcome> {
  return runInChildProcess(new URL("./shipment-worker.js", import.meta.url), options);
}
