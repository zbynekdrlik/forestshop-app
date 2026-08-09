import { chromium, type Browser, type Page } from "playwright";
import { log } from "../../logger.js";
import { resolveChromiumExecutablePath } from "../shoptet-writeback/playwright-import.js";
import { runInChildProcess } from "../shoptet-writeback/child-runner.js";
import { loginToDpdPortal } from "./login.js";
import type { DpdPortalConfig } from "./config.js";
import { DEFAULT_PARCEL_HEIGHT_CM, DEFAULT_PARCEL_LENGTH_CM, DEFAULT_PARCEL_WIDTH_CM, type DpdShipmentPreview } from "./preview.js";
import { assertSlovakDeliveryCountry, normalizePhoneForDpd, typeInto, waitUntilEnabled } from "./portal-fill.js";

/**
 * issue 292: Playwright robot na `dpdshipper.sk` — rovnaký izolovaný
 * dieťa-proces vzor ako `shoptet-writeback` (issue 313, `.claude/rules/
 * shoptet-writeback.md`). Prihlásenie (`login.ts`) aj formulár
 * `/shipments/0` sú naživo domapované (9.8.2026, read-only route guard —
 * každý zápis po prihlásení tvrdo blokovaný, nič sa neobjednalo). Presné
 * selektory + zistenia (povinné rozmery balíka, `.fill()` nedrží hodnotu na
 * wijmo widgetoch, COD-suma pole sa nedalo bezpečne domapovať) sú v
 * `.claude/rules/dpd.md` a v issue 292's návrhu riešenia.
 */
const PRODUCT_RADIO_SELECTOR = "#product_Home"; // DPD HOME — bežný domáci rozvoz, appka iný typ zatiaľ nerozlišuje
const COD_CHECKBOX_SELECTOR = "#service-COD";

async function fillRecipient(page: Page, shipment: DpdShipmentPreview): Promise<void> {
  if (shipment.countryName !== null) assertSlovakDeliveryCountry(shipment.countryName);
  await typeInto(page, '#shipment_order_recipient-recipient-name input[type=search]', shipment.recipientName);
  if (shipment.recipientCompany !== null && shipment.recipientCompany.trim() !== "") {
    await page.fill("#shipment_order_recipient-recipient-name2", shipment.recipientCompany);
  }
  await page.fill("#shipment_order_recipient-recipient-street", shipment.street ?? "");
  await page.fill("#shipment_order_recipient-recipient-house-nr", shipment.houseNumber ?? "");
  await typeInto(page, '#shipment_order_recipient-recipient-zip input[type=search]', shipment.zip ?? "");
  await typeInto(page, '#shipment_order_recipient-recipient-city input[type=search]', shipment.city ?? "");
  if (shipment.recipientPhone !== null && shipment.recipientPhone.trim() !== "") {
    await page.fill('input[name="number"]', normalizePhoneForDpd(shipment.recipientPhone));
  }
}

async function fillParcel(page: Page, weightKg: string): Promise<void> {
  await typeInto(page, 'input[placeholder="Hmotnosť"]', weightKg);
  // issue 292: rozmery sú POVINNÉ, appka ich nemá — appka-vlastné rozumné
  // defaulty (`.claude/rules/dpd.md`), nikdy hádanie reálnej hodnoty.
  await typeInto(page, 'input[name="parcelWidth"]', DEFAULT_PARCEL_WIDTH_CM);
  await typeInto(page, 'input[name="parcelHeight"]', DEFAULT_PARCEL_HEIGHT_CM);
  await typeInto(page, 'input[name="parcelLength"]', DEFAULT_PARCEL_LENGTH_CM);
}

/** Po zaškrtnutí "Dobierka" portál vykreslí NOVÉ pole na sumu — jeho presný
 * selektor sa NEDAL naživo bezpečne domapovať (checkbox je v read-only
 * sandboxe trvalo disabled, `.claude/rules/dpd.md`). Namiesto hádania:
 * počkaj na nový input v tom istom kontajneri, fail-loud ak sa neobjaví. */
async function fillCodAmount(page: Page, codAmount: string): Promise<void> {
  await waitUntilEnabled(page, COD_CHECKBOX_SELECTOR, 10_000, "Dobierka (COD) prepínač");
  await page.check(COD_CHECKBOX_SELECTOR);
  const container = page.locator(COD_CHECKBOX_SELECTOR).locator("xpath=ancestor::div[contains(@class,'additional-service')][1]");
  const amountInput = container.locator(`input:not(${COD_CHECKBOX_SELECTOR})`).first();
  const appeared = await amountInput
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    throw new Error(
      "DPD formulár: po zaškrtnutí Dobierka sa neobjavilo pole na sumu — selektor nie je naživo domapovaný, over ho ručne (fillCodAmount v shipment-playwright.ts)",
    );
  }
  await amountInput.click({ clickCount: 3 });
  await page.keyboard.press("Control+A");
  await page.keyboard.type(codAmount, { delay: 20 });
  await page.keyboard.press("Tab");
}

async function readParcelNumberAfterSave(page: Page, referenceForCorrelation: string): Promise<string> {
  const digitPattern = /\d{8,}/;
  const toastText = await page
    .locator('[id*="toast"], .toast-container')
    .first()
    .textContent({ timeout: 6000 })
    .catch(() => null);
  const toastMatch = toastText !== null ? digitPattern.exec(toastText) : null;
  if (toastMatch !== null) return toastMatch[0];

  // Fallback: notifikácia sa nezobrazila/nenašla — skús zoznam Zásielky,
  // nájdi riadok s našou referenciou (appka ju posiela do "Referencia 1").
  await page.goto(new URL("/shipments", page.url()).toString(), { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const row = page.locator("tr", { hasText: referenceForCorrelation }).first();
  const rowText = await row.textContent({ timeout: 6000 }).catch(() => null);
  const rowMatch = rowText !== null ? digitPattern.exec(rowText) : null;
  if (rowMatch !== null) return rowMatch[0];

  throw new Error(
    `DPD formulár: zásielka bola pravdepodobne uložená, ale číslo zásielky sa nepodarilo prečítať (ani z notifikácie, ani zo zoznamu podľa referencie "${referenceForCorrelation}") — over ručne v portáli`,
  );
}

async function fillShipmentFields(page: Page, shipment: DpdShipmentPreview): Promise<string> {
  await waitUntilEnabled(page, PRODUCT_RADIO_SELECTOR, 15_000, "typ produktu DPD HOME");
  await page.check(PRODUCT_RADIO_SELECTOR);

  await page.fill("#referential-info1", shipment.externalOrderId);
  await fillParcel(page, shipment.weightKg);
  await fillRecipient(page, shipment);
  if (shipment.isCod && shipment.codAmount !== null) {
    await fillCodAmount(page, shipment.codAmount);
  }

  const saveButton = page.getByRole("button", { name: /Uložiť & Nová/ });
  await saveButton.click();
  return readParcelNumberAfterSave(page, shipment.externalOrderId);
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

    const parcelNumber = await fillShipmentFields(page, options.shipment);
    return { ok: true, parcelNumber, errorDetail: null };
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
