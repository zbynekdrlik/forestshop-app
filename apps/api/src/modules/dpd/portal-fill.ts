import { chromium, type Browser, type Locator, type Page } from "playwright";
import { resolveChromiumExecutablePath } from "../shoptet-writeback/playwright-import.js";
import { loginToDpdPortal } from "./login.js";
import type { DpdPortalConfig } from "./config.js";

/**
 * issue 292: zdieľané nízkoúrovňové pomôcky na vypĺňanie formulárov na
 * `dpdshipper.sk`, použité `shipment-playwright.ts` aj `pickup-playwright.ts`.
 *
 * **`.fill()` NEDRŽÍ hodnotu na wijmo widgetoch** (`wj-input-date`,
 * `wj-input-number`, appka's vlastný `shp-universal-number-input`) — naživo
 * overené (9.8.2026, read-only mapovanie): hodnota vyzerala nastavená
 * (`.value` v DOM sedelo), ale po prechode na ďalší krok viackrokového
 * formulára (napr. objednávka zvozu) sa vrátila na pôvodnú, Angular model
 * ju teda reálne neprevzal. Funkčná náhrada, overená naživo (hodnota
 * PRETRVALA cez prechod kroku, DOM trieda `ng-valid` namiesto `ng-invalid`):
 * klik (trojklik = vyber všetko) → `Control+A` → `keyboard.type()` → `Tab`
 * (blur commit-ne hodnotu do Angular FormControl). Rovnaká trieda chyby ako
 * `.claude/rules/shoptet-writeback.md`'s "`.fill()` na prihlasovacie polia
 * nedrží v appka's vlastnom procese" nález — iný mechanizmus (tu je to o
 * Angular/wijmo binding, tam o Node/Chromium interakcii v dlho bežiacom
 * procese), ale rovnaká disciplína: over čítaním hodnoty SPÄŤ, nikdy sa
 * nespoliehaj na to, že `.fill()`/klik "prešiel".
 *
 * **Prijíma AJ už-vyriešený `Locator`, nielen selektor** (code review
 * issue 292, PR 324) — `fillCodAmount` v `shipment-playwright.ts` potrebuje
 * vyplniť pole, ktoré si sám našiel porovnaním DOM PRED/PO (nemá preň
 * jednoduchý statický selektor), a musí ísť rovnakou cestou ako každé iné
 * pole na tomto portáli namiesto vlastného kopírovania tej istej sekvencie.
 */
export async function typeInto(page: Page, target: string | Locator, text: string): Promise<void> {
  const loc = typeof target === "string" ? page.locator(target).first() : target;
  await loc.click({ clickCount: 3, timeout: 10_000 });
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press("Tab");
}

/**
 * Produktový typ (`#product_Home`) aj "Dobierka" (`#service-COD`) sú v DOM
 * `disabled`, kým portál sám nedokončí svoj vlastný inicializačný
 * (produkty/ceny) request po prihlásení — naživo overené, že to trvá
 * krátko, ale nie okamžite. Radšej krátke čakanie s jasným fail-loud
 * timeoutom než tiché preskočenie/vynútené odblokovanie (to druhé sa
 * naživo skúsilo a Playwright's vlastná akcionabilita ho aj tak odmietla —
 * Angular `disabled` binding sa priebežne prepisuje).
 */
export async function waitUntilEnabled(page: Page, selector: string, timeoutMs: number, description: string): Promise<void> {
  const loc = page.locator(selector).first();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const disabled = await loc.isDisabled().catch(() => true);
    if (!disabled) return;
    if (Date.now() >= deadline) {
      throw new Error(`DPD portál: "${description}" zostáva neaktívne aj po ${String(timeoutMs)} ms — formulár sa pravdepodobne nenačítal úplne`);
    }
    await page.waitForTimeout(300);
  }
}

// Naživo overené (9.8.2026): telefónne číslo v appke je Shoptet-ov tvar
// (napr. "+421903123456"/"0903123456"), ale DPD formulár má predvoľbu
// ("+421") v SAMOSTATNOM poli — `recipient-phone-number` čaká len národné
// číslo bez predvoľby/nuly. Appka podporuje LEN slovenské čísla (rovnaký
// rozsah ako krajina nižšie) — iný tvar zlyhá nahlas namiesto tichého
// odoslania niečoho, čo portál buď odmietne, alebo (horšie) ticho prijme
// ako nezmyselné číslo.
//
// Code review (issue 292, PR 324): pôvodná verzia validovala DĹŽKU výsledku
// LEN vo vetve "už je to holé 9-miestne číslo" — po odstránení uznaného
// prefixu sa výsledok už nekontroloval vôbec, takže napr. "00903123456"
// (zle zadaná domáca nula namiesto medzinárodnej predvoľby) prešlo ako
// "0903123456" (10 číslic, nezmysel) namiesto zlyhania nahlas. Kontrola
// DĹŽKY je teraz JEDNOTNÁ pre všetky vetvy — platí AŽ PO odstránení prefixu.
const SK_NATIONAL_NUMBER_LENGTH = 9;

export function normalizePhoneForDpd(rawPhone: string): string {
  const digitsOnly = rawPhone.replace(/[^\d]/g, "");
  const national = digitsOnly.startsWith("00421")
    ? digitsOnly.slice(5)
    : digitsOnly.startsWith("421")
      ? digitsOnly.slice(3)
      : digitsOnly.startsWith("0")
        ? digitsOnly.slice(1)
        : digitsOnly;
  if (national.length === SK_NATIONAL_NUMBER_LENGTH) return national;
  throw new Error(`DPD formulár: telefónne číslo "${rawPhone}" nevyzerá ako slovenské číslo — over ho ručne, appka odosiela len SK čísla`);
}

// Naživo overené (9.8.2026): predvolená hodnota selectu krajiny príjemcu
// je už "Slovensko" — appka teda krajinu NEVYBERÁ aktívne (žiadne
// spoľahlivé mapovanie Shoptet-ovho textu na DPD interné číselné ID pre
// iné krajiny), len OVERÍ, že objednávka je skutočne slovenská, predtým
// než čokoľvek odošle. Iná krajina zlyhá nahlas namiesto tichého odoslania
// s nesprávne vybranou (portálovo predvolenou) krajinou.
const SLOVAK_COUNTRY_NAMES = new Set(["slovensko", "slovenská republika", "slovak republic", "slovakia", "sk"]);

export function assertSlovakDeliveryCountry(countryName: string): void {
  const normalized = countryName.trim().toLowerCase();
  if (!SLOVAK_COUNTRY_NAMES.has(normalized)) {
    throw new Error(
      `DPD formulár: doručovacia krajina "${countryName}" nie je slovenská — appka zatiaľ podporuje len SK zásielky (portál by inak odoslal so ` +
        "svojou predvolenou krajinou, nie so skutočnou adresou príjemcu)",
    );
  }
}

// issue 451 (Štěpánov krok 2): po prihlásení portál môže ukázať info banner
// („Aktuálne obmedzenia…") so zatváracím ✕, ktorý — ak prekryje formulár —
// zachytí klik na „Pokračovať"/„Uložiť". Zámerne ŠIROKÝ, tolerantný výber
// zatváracích prvkov v banner/alert/notification kontajneroch. Presný
// selektor reálneho bannera je UNVERIFIED (mapovanie 9.8.2026 bolo
// read-only, a z lane sa robot NESMIE spustiť naživo) — preto tolerantný
// zoznam; over/zúž ho pri prvom reálnom zvoze.
const INFO_BANNER_CLOSE_SELECTORS: readonly string[] = [
  '[aria-label="Zavrieť" i]',
  '[aria-label="Zavriet" i]',
  '[aria-label="Close" i]',
  '[class*="banner"] [class*="close"]',
  '[class*="notification"] [class*="close"]',
  '[class*="alert"] [class*="close"]',
  "button.close",
  'button:has-text("✕")',
  'button:has-text("×")',
];

/**
 * Štěpánov krok 2 (issue 451): zatvorí prekrývajúce info bannery/hlášky PRED
 * vyplnením formulára. Zámerne BEST-EFFORT a fail-SOFT, NIE fail-loud —
 * chýbajúci banner je NORMÁLNY stav (na rozdiel od povinného poľa, ktoré
 * appka MUSÍ vyplniť), takže absencia = no-op, nikdy throw. Ak by prekrytie
 * predsa zostalo, `checkForPortalError` po Uložení aj tak zlyhá nahlas —
 * táto pomôcka teda nič nezhoršuje, len odstráni bežnú prekážku. Volá sa
 * LEN z pickup vetvy (`pickup-playwright.ts`), shipment vetva ostáva
 * nedotknutá.
 */
export async function dismissInfoBanners(page: Page): Promise<void> {
  for (const selector of INFO_BANNER_CLOSE_SELECTORS) {
    const closers = await page
      .locator(selector)
      .all()
      .catch(() => [] as Locator[]);
    for (const closer of closers) {
      const visible = await closer.isVisible().catch(() => false);
      if (!visible) continue;
      await closer.click({ timeout: 1500 }).catch(() => {
        // best-effort: tento prvok nemusí byť skutočný zatvárací ovládač
      });
    }
  }
}

export interface RunOnDpdPortalPageOptions {
  readonly headless?: boolean;
  readonly executablePath?: string;
}

/**
 * Zdieľaný životný cyklus prehliadača (launch → context → page → prihlásenie
 * → `action` → vždy zatvoriť) — code review (issue 292, PR 324) našiel, že
 * `runCreateDpdShipment`/`runOrderDpdPickup` mali TOTOŽNÝ blok skopírovaný,
 * líšiaci sa len návratovým tvarom a vnútorným volaním vypĺňania. Navigáciu
 * na konkrétny formulár (rôzna URL pre zásielku/zvoz) robí `action` sám —
 * tento helper vie len prihlásiť a upratať po sebe.
 */
export async function runOnDpdPortalPage<T>(
  config: DpdPortalConfig,
  options: RunOnDpdPortalPageOptions,
  action: (page: Page) => Promise<T>,
): Promise<T> {
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
    await loginToDpdPortal(page, config);
    return await action(page);
  } finally {
    await browser?.close();
  }
}
