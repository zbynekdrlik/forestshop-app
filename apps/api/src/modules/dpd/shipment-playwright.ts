import type { Page } from "playwright";
import { log } from "../../logger.js";
import { runInChildProcess } from "../shoptet-writeback/child-runner.js";
import type { DpdPortalConfig } from "./config.js";
import { DEFAULT_PARCEL_HEIGHT_CM, DEFAULT_PARCEL_LENGTH_CM, DEFAULT_PARCEL_WIDTH_CM, type DpdShipmentPreview } from "./preview.js";
import { assertSlovakDeliveryCountry, normalizePhoneForDpd, runOnDpdPortalPage, typeInto, waitUntilEnabled } from "./portal-fill.js";

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
  // Code review (issue 292, PR 324): pôvodná verzia preskočila kontrolu
  // úplne pri `countryName === null` — presne ten neistý prípad, pred
  // ktorým má appku chrániť. `http/dpd-routes.ts`'s `addressComplete` brána
  // dnes `null` k tejto funkcii vôbec nepustí, ale to je záruka v INOM
  // súbore — volaj kontrolu VŽDY, prázdny reťazec cez `?? ""` ňou aj tak
  // neprejde.
  assertSlovakDeliveryCountry(shipment.countryName ?? "");
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
 * sandboxe trvalo disabled, `.claude/rules/dpd.md`). Namiesto hádania
 * "prvý input v kontajneri" (code review, issue 292, PR 324 — to by
 * omylom vybralo AKÝKOĽVEK existujúci vstup v tom istom kontajneri, nielen
 * novo pridaný): spočítaj vstupy PRED zaškrtnutím, počkaj, kým sa objaví
 * GENUINNE nový (počet vzrastie), vyplň PRÁVE TEN. */
async function fillCodAmount(page: Page, codAmount: string): Promise<void> {
  await waitUntilEnabled(page, COD_CHECKBOX_SELECTOR, 10_000, "Dobierka (COD) prepínač");
  const container = page.locator(COD_CHECKBOX_SELECTOR).locator("xpath=ancestor::div[contains(@class,'additional-service')][1]");
  const otherInputs = container.locator(`input:not(${COD_CHECKBOX_SELECTOR})`);
  const countBefore = await otherInputs.count();
  await page.check(COD_CHECKBOX_SELECTOR);
  // Playwright's vlastné typované `.count()` polling (rovnaký vzor ako
  // `portal-fill.ts`'s `waitUntilEnabled`) — nikdy `page.waitForFunction`
  // s priamym `document` odkazom, apps/api's tsconfig nemá DOM lib
  // (`.claude/rules/testing.md`, rovnaké obmedzenie ako `shoptet-writeback/
  // playwright-import.ts`'s `rowTexts` komentár).
  const deadline = Date.now() + 8000;
  for (;;) {
    if ((await otherInputs.count()) > countBefore) break;
    if (Date.now() >= deadline) {
      throw new Error(
        "DPD formulár: po zaškrtnutí Dobierka sa neobjavil ŽIADEN NOVÝ vstup na sumu — selektor nie je naživo domapovaný, over ho ručne (fillCodAmount v shipment-playwright.ts)",
      );
    }
    await page.waitForTimeout(300);
  }
  const amountInput = otherInputs.nth((await otherInputs.count()) - 1);
  await typeInto(page, amountInput, codAmount);
}

// Code review (issue 292, PR 324): reálne DPD čísla zásielok pozorované
// naživo (`.claude/rules/dpd.md`) sú 14-miestne, appka's vlastná referencia
// (`externalOrderId`, Shoptet objednávkové číslo) je typicky 8-miestna —
// pôvodný `/\d{8,}/` by preto v zálohovom zoznamovom hľadaní (keď sa
// nenašla notifikácia) mohol omylom vrátiť SAMOTNÚ referenciu namiesto
// skutočného čísla zásielky (obe čísla sú v tom istom riadku, referencia
// tam je ZÁRUČNE prítomná — presne preto sa podľa nej riadok hľadá).
// Minimálna dĺžka 10 aj explicitné vylúčenie zhody s referenciou sú DVE
// nezávislé poistky proti tomuto.
export function extractParcelNumber(text: string, reference: string): string | null {
  const matches = text.match(/\d{10,}/g) ?? [];
  return matches.find((m) => m !== reference) ?? null;
}

async function readParcelNumberAfterSave(page: Page, referenceForCorrelation: string): Promise<string> {
  const toastText = await page
    .locator('[id*="toast"], .toast-container')
    .first()
    .textContent({ timeout: 6000 })
    .catch(() => null);
  const toastMatch = toastText !== null ? extractParcelNumber(toastText, referenceForCorrelation) : null;
  if (toastMatch !== null) return toastMatch;

  // Fallback: notifikácia sa nezobrazila/nenašla — skús zoznam Zásielky,
  // nájdi riadok s našou referenciou (appka ju posiela do "Referencia 1").
  await page.goto(new URL("/shipments", page.url()).toString(), { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const row = page.locator("tr", { hasText: referenceForCorrelation }).first();
  const rowText = await row.textContent({ timeout: 6000 }).catch(() => null);
  const rowMatch = rowText !== null ? extractParcelNumber(rowText, referenceForCorrelation) : null;
  if (rowMatch !== null) return rowMatch;

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
  if (shipment.isCod) {
    // Code review (issue 292, PR 324): `codAmount` sa dá naparsovať na
    // `null` aj pri dobierkovej objednávke (`preview.ts`'s
    // `priceToPay`/`totalPriceWithVat` obe chýbajúce/neparsovateľné) — bez
    // tejto kontroly by appka TICHO odoslala zásielku BEZ dobierky, kuriér
    // by peniaze od zákazníka nevybral. Rovnaká disciplína ako hmotnosť/
    // krajina/telefón vyššie: neisté = zlyhaj nahlas, nikdy nehádaj 0.
    if (shipment.codAmount === null) {
      throw new Error(
        `DPD zásielka ${shipment.externalOrderId} je označená ako dobierka, ale suma sa nedá určiť (chýba priceToPay aj totalPriceWithVat) — over cenu objednávky ručne, appka ju bez toho neodošle`,
      );
    }
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
  try {
    const parcelNumber = await runOnDpdPortalPage(options.config, options, async (page) => {
      await page.goto(options.config.newShipmentUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");
      return fillShipmentFields(page, options.shipment);
    });
    return { ok: true, parcelNumber, errorDetail: null };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message, externalOrderId: options.shipment.externalOrderId }, "DPD zásielka: pokus zlyhal");
    return { ok: false, parcelNumber: null, errorDetail: message };
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
