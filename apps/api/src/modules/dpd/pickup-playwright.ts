import type { Page } from "playwright";
import { log } from "../../logger.js";
import { runInChildProcess } from "../shoptet-writeback/child-runner.js";
import type { DpdPortalConfig } from "./config.js";
import { dismissInfoBanners, runOnDpdPortalPage, typeInto } from "./portal-fill.js";

// issue 292/491: "Objednávky zvozu" (`/pickup-orders`) — naživo overené
// (7.8.2026 menu, 9.8.2026 + 26.8.2026 formulár): klik "+" pri "Jednorazové
// zvozy" navigoval na `/pickup-orders/0` (`config.ts`'s `newPickupOrderUrl`),
// teda priama navigácia je spoľahlivejšia než hľadanie tlačidla. Formulár je
// JEDEN Angular `<form class="data">` (zvozová adresa/kontakt/dátum, predvyplnené
// z účtu, appka mení LEN `#pickup-date`) s tlačidlom `#button-confirmation`
// "Pokračovať". Klik "Pokračovať" NEnaviguje (URL ostáva `/pickup-orders/0`) —
// Angular RE-RENDERuje NA MIESTE na REVIEW krok: zmizne `#button-confirmation`,
// objaví sa `.panel.warning` + readonly polia + `#button-save` "Uložiť". Skutočné
// odoslanie = klik `#button-save`. (Predtým sa hádali `#step1`/`#step2` step-
// container ID, ktoré v reálnom DOM NEEXISTUJÚ — `#step2` waitFor timeoutoval
// 8000 ms; issue 491.)
const PICKUP_DATE_SELECTOR = '#pickup-date input[wj-part="input"]';
const CONTINUE_BUTTON_SELECTOR = "#button-confirmation";
const SAVE_BUTTON_SELECTOR = "#button-save";
// Chybové hlásenie portálu — scoped na toast/alert kontajnery s chybovým textom
// (NIE bežné validačné `[class*=error]` triedy, aby po úspešnej navigácii na
// zoznam nevznikol falošný pozitív). Reálne info toasty (`shp-newsfeed-toast`,
// text "obmedzenia"/"pravidlá") tento vzor NEmatchujú.
const PORTAL_ERROR_SELECTOR =
  '.alert-danger, .toast-error, [id*="toast"] :text-matches("chyb|zlyha|nepodarilo|error", "i")';

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

async function checkForPortalError(page: Page): Promise<string | null> {
  const errorText = await page
    .locator(PORTAL_ERROR_SELECTOR)
    .first()
    .textContent({ timeout: 3000 })
    .catch(() => null);
  return errorText !== null && errorText.trim() !== "" ? errorText.trim() : null;
}

async function fillPickupForm(page: Page, pickupDate: string): Promise<void> {
  await typeInto(page, PICKUP_DATE_SELECTOR, toDpdDateFormat(pickupDate));
  await page.locator(CONTINUE_BUTTON_SELECTOR).click();

  // Klik "Pokračovať" re-renderuje formulár NA MIESTE na REVIEW krok — objaví sa
  // `#button-save` ("Uložiť") a zmizne `#button-confirmation` (naživo overené
  // issue 491). Čakáme na skutočný marker review kroku namiesto neexistujúceho
  // `#step1`/`#step2` (to timeoutovalo). Angular prekreslenie môže na reálnom
  // (ťažšom) portáli trvať dlhšie než pevná pauza — deterministické čakanie.
  await page.locator(SAVE_BUTTON_SELECTOR).waitFor({ state: "visible", timeout: 10_000 });

  // Poistka: ak sa medzitým znovu objavil prekrývajúci info toast, zavri ho,
  // inak by zachytil klik na "Uložiť" (fail-soft, no-op keď žiadny nie je).
  await dismissInfoBanners(page);

  const saveButton = page.locator(SAVE_BUTTON_SELECTOR);
  await saveButton.click();

  // Fail-loud POZITÍVNE overenie výsledku (issue 491, uzatvára dpd.md UNVERIFIED
  // poznámku): po Uložení sa objednávka odošle do DPD a portál buď opustí review
  // krok (`#button-save` sa odpojí — navigácia na zoznam / re-render = ÚSPECH),
  // alebo zobrazí chybový toast (ZLYHANIE). Nikdy tiché optimistické "ok".
  const outcome = await Promise.race([
    saveButton
      .waitFor({ state: "detached", timeout: 20_000 })
      .then(() => "saved" as const)
      .catch(() => "timeout" as const),
    page
      .locator(PORTAL_ERROR_SELECTOR)
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => "error" as const)
      .catch(() => "timeout" as const),
  ]);
  await page.waitForLoadState("networkidle").catch(() => {});

  const errorText = await checkForPortalError(page);
  if (errorText !== null) {
    throw new Error(`DPD portál nahlásil chybu pri objednaní zvozu: ${errorText}`);
  }
  if (outcome !== "saved") {
    throw new Error(
      "DPD zvoz: po kliknutí Uložiť sa objednávka nepotvrdila (review krok nezmizol ani sa nezobrazila chyba) — over stav ručne v portáli",
    );
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
  try {
    await runOnDpdPortalPage(options.config, options, async (page) => {
      await page.goto(options.config.newPickupOrderUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");
      // Štěpánov krok 2: zatvor prekrývajúce info hlášky, inak by zachytili
      // klik na „Pokračovať"/„Uložiť" (issue 451). Best-effort — no-op, keď
      // žiadny banner nie je.
      await dismissInfoBanners(page);
      await fillPickupForm(page, options.pickupDate);
    });
    return { ok: true, errorDetail: null };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message, pickupDate: options.pickupDate }, "DPD zvoz: pokus zlyhal");
    return { ok: false, errorDetail: message };
  }
}

export type OrderPickupWorkerInput = RunOrderDpdPickupOptions;

export function runOrderDpdPickupIsolated(options: RunOrderDpdPickupOptions): Promise<OrderDpdPickupOutcome> {
  return runInChildProcess(new URL("./pickup-worker.js", import.meta.url), options);
}
