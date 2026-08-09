import type { Page } from "playwright";

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
 */
export async function typeInto(page: Page, selector: string, text: string): Promise<void> {
  const loc = page.locator(selector).first();
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
export function normalizePhoneForDpd(rawPhone: string): string {
  const digitsOnly = rawPhone.replace(/[^\d]/g, "");
  if (digitsOnly.startsWith("00421")) return digitsOnly.slice(5);
  if (digitsOnly.startsWith("421")) return digitsOnly.slice(3);
  if (digitsOnly.startsWith("0")) return digitsOnly.slice(1);
  if (digitsOnly.length === 9) return digitsOnly;
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
