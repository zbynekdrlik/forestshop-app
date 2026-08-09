import type { Page } from "playwright";
import { log } from "../../logger.js";
import { runInChildProcess } from "../shoptet-writeback/child-runner.js";
import type { DpdPortalConfig } from "./config.js";
import { runOnDpdPortalPage, typeInto } from "./portal-fill.js";

// issue 292: "Objednávky zvozu" (`/pickup-orders`) — naživo overené
// (7.8.2026 menu, 9.8.2026 formulár): klik "+" pri "Jednorazové zvozy"
// navigoval na `/pickup-orders/0` (`config.ts`'s `newPickupOrderUrl`), teda
// priama navigácia je spoľahlivejšia než hľadanie tlačidla. Formulár je
// DVOJKROKOVÝ — krok 1 (zvozová adresa/kontakt/dátum, predvyplnené z účtu,
// appka mení LEN dátum) → "Pokračovať" → krok 2 (rovnaká URL, appka's
// vlastný SPA prechod) → skutočné "Uložiť".
const PICKUP_DATE_SELECTOR = '#pickup-date input[wj-part="input"]';
const CONTINUE_BUTTON_SELECTOR = "#button-confirmation";
const STEP1_SELECTOR = "#step1";
const STEP2_SELECTOR = "#step2";

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

/**
 * Code review (issue 292, PR 324): "úspech" tu ostáva NEPRIAMY dôkaz
 * (absencia chyby), lebo skutočný pozitívny signál sa nedal naživo overiť
 * (rovnaké bezpečnostné pravidlo ako pri zásielke — prvý reálny klik patrí
 * majiteľovi, `.claude/rules/dpd.md`). Kontrola je preto zámerne ŠIROKÁ:
 * najprv overený `#toast-container`/`[id*="toast"]` mechanizmus (rovnaký,
 * aký appka už naživo videla vypisovať systémové správy PO prihlásení na
 * `/pickup-orders`), potom aj bežné chybové CSS triedy ako záloha. Kým sa
 * toto neoverí prvým skutočným zvozom, každé "ok:true" tu je optimistické,
 * NIE potvrdené — pozri `.claude/rules/dpd.md`'s UNVERIFIED poznámku.
 */
async function checkForPortalError(page: Page): Promise<string | null> {
  const errorText = await page
    .locator('[id*="toast"] :text-matches("chyb|zlyha|nepodarilo|error", "i"), .toast-error, .alert-danger, [class*="error"]:visible')
    .first()
    .textContent({ timeout: 3000 })
    .catch(() => null);
  return errorText !== null && errorText.trim() !== "" ? errorText.trim() : null;
}

async function fillPickupForm(page: Page, pickupDate: string): Promise<void> {
  await typeInto(page, PICKUP_DATE_SELECTOR, toDpdDateFormat(pickupDate));
  await page.locator(CONTINUE_BUTTON_SELECTOR).click();
  // Deterministické čakanie namiesto pevného spánku (code review, issue
  // 292, PR 324) — krok 1 sa naozaj skryje AŽ keď Angular prekreslí, na
  // reálnom (ťažšom) portáli to môže trvať dlhšie než pevná pauza.
  await page.locator(STEP1_SELECTOR).waitFor({ state: "hidden", timeout: 8000 });
  await page.locator(STEP2_SELECTOR).waitFor({ state: "visible", timeout: 8000 });

  const saveButton = page.getByRole("button", { name: "Uložiť", exact: true });
  await saveButton.click();
  await page.waitForLoadState("networkidle").catch(() => {});

  const errorText = await checkForPortalError(page);
  if (errorText !== null) {
    throw new Error(`DPD portál nahlásil chybu pri objednaní zvozu: ${errorText}`);
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
