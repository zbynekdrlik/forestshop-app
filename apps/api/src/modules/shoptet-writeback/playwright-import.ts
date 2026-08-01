import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { log } from "../../logger.js";
import type { ShoptetImportConfig } from "./config.js";
import { entryKey, hasLogEntries, parseImportLog, pickResultRow, resultExitCode } from "./log-attribution.js";

/**
 * Playwright automatizácia hromadného CSV importu do Shoptetu — port zo
 * sesterského `parovanie_produktov`'s `scripts/shoptet_import.py`
 * (`_login`/`_goto_import`/`_ensure_safe_settings`/`_do_import`/
 * `_read_result`), ktorý má tento presný postup overený naživo. Nikdy sa
 * nespolieha na to, že klik "prešiel" — bezpečné nastavenia (režim
 * "Nemeniť mimo súboru", "Zmeniť URL podľa názvu" VYPNUTÉ) sa VŽDY čítajú
 * READ-BACK po nastavení, a výsledok importu sa vždy overuje z Logu, nikdy
 * len z toho, že formulár sa odoslal bez chyby.
 */

const SAFE_RADIO_NAME = "Nemeniť produkty a varianty, ktoré nie sú obsiahnuté v importovanom súbore.";
const URL_BY_NAME_CHECKBOX = "Zmeňte adresu URL produktu podľa názvu produktu.";

export interface RunShoptetImportOptions {
  readonly config: ShoptetImportConfig;
  readonly csv: Buffer;
  readonly expectedRows: number;
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly resultPollRetries?: number;
  readonly resultPollWaitMs?: number;
}

export interface ShoptetImportOutcome {
  readonly ok: boolean;
  readonly processed: number | null;
  readonly updated: number | null;
  readonly failed: number | null;
  readonly errorDetail: string | null;
  readonly rawResultText: string | null;
}

/** Alpine-friendly default: apk-installed `chromium` v produkčnom image
 * (Dockerfile) namiesto Playwright's vlastného (glibc-only) stiahnutého
 * binárky, ktorá na musl-libc Alpine nikdy nenaštartuje. Mimo produkčného
 * obrazu (CI/lokálny dev, Ubuntu) žiadna z týchto ciest neexistuje →
 * `undefined` → Playwright použije svoj vlastný bežne nainštalovaný
 * chromium (`playwright install chromium`). */
export function resolveChromiumExecutablePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env["CHROMIUM_EXECUTABLE_PATH"];
  if (override !== undefined && override !== "") return override;
  for (const candidate of ["/usr/bin/chromium-browser", "/usr/bin/chromium"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Text obsahu KAŽDÉHO `<tr>` na stránke, zbalený whitespace — cez Playwright's
 * vlastné (typované) `locator().allTextContents()`, nikdy `page.evaluate()`
 * s priamym `document` odkazom (apps/api's tsconfig nemá DOM lib — je to
 * Node backend, nie browser kód — `.claude/rules/testing.md`'s poznámka o
 * `apps/web/tests/e2e/tsconfig.json`'s DOM libu platí LEN pre e2e testy, nie
 * pre backend automatizáciu ako túto). */
async function rowTexts(page: Page): Promise<string[]> {
  const raw = await page.locator("tr").allTextContents();
  return raw.map((t) => t.replace(/\s+/g, " ").trim());
}

async function login(page: Page, config: ShoptetImportConfig): Promise<void> {
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("E-mail").fill(config.user);
  await page.getByPlaceholder("Vaše heslo").fill(config.password);
  await page.getByRole("button", { name: "Prihlásenie" }).click();
  await page.waitForLoadState("networkidle");
  // NIKDY substring na URL ("/login") — reálny Shoptet login pre tento obchod
  // je na `${adminBaseUrl}/admin/` a úspešné prihlásenie sa vráti na TÚ ISTÚ
  // URL (overené naživo pri návrhu #122: dry-run skript ukázal "[login] OK →
  // https://www.forestshop.sk/admin/", teda nezmenenú URL). Jediný spoľahlivý
  // signál zlyhania je, že prihlasovací formulár je STÁLE na stránke.
  if ((await page.getByPlaceholder("E-mail").count()) > 0) {
    throw new Error("Prihlásenie do Shoptetu zlyhalo (prihlasovací formulár stále viditeľný) — over SHOPTET_ADMIN_USER/PASSWORD");
  }
}

async function captureBaseline(page: Page, config: ShoptetImportConfig): Promise<string | null> {
  await page.goto(config.logUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  return pickResultRow(await rowTexts(page), { baseline: null, expectedRows: null });
}

async function ensureSafeSettings(page: Page): Promise<void> {
  const safeRadio = page.getByRole("radio", { name: SAFE_RADIO_NAME });
  if ((await safeRadio.count()) === 0) {
    throw new Error(`Nenašiel som voľbu bezpečného režimu importu ("${SAFE_RADIO_NAME}") — neimportujem`);
  }
  await safeRadio.check();
  const urlByName = page.getByRole("checkbox", { name: URL_BY_NAME_CHECKBOX });
  if ((await urlByName.count()) > 0 && (await urlByName.isChecked())) {
    await urlByName.uncheck();
  }
  if (!(await safeRadio.isChecked())) {
    throw new Error("Bezpečný režim 'Nemeniť produkty mimo súboru' sa nepodarilo nastaviť — neimportujem");
  }
  if ((await urlByName.count()) > 0 && (await urlByName.isChecked())) {
    throw new Error("'Zmeniť URL podľa názvu' ostáva zapnuté — neimportujem");
  }
}

async function pollForResult(
  page: Page,
  config: ShoptetImportConfig,
  baseline: string | null,
  expectedRows: number,
  retries: number,
  waitMs: number,
): Promise<string | null> {
  const seen = new Set<string>();
  let verdict: string | null = null;
  let verdictIsReal = false;
  for (let attempt = 0; attempt < retries; attempt++) {
    const texts = await rowTexts(page);
    const row = pickResultRow(texts, { baseline, expectedRows });
    // entryKey (nie surový text riadku) — Shoptetov '#id' zostáva stabilný
    // naprieč čítaniami, ale surový text vie tikať (relatívny čas), čo by
    // "settle" kontrolu nižšie (seen.size !== 1) nechalo nikdy zjednotiť sa
    // (parovanie_produktov's _read_result má rovnaký dôvod pre _entry_key).
    if (row !== null) seen.add(entryKey(row));
    if (hasLogEntries(texts)) {
      verdict = row;
      verdictIsReal = true;
    }
    if (attempt < retries - 1) {
      await page.waitForTimeout(waitMs);
      await page.goto(config.logUrl, { waitUntil: "networkidle" });
    }
  }
  if (!verdictIsReal || verdict === null || seen.size !== 1) return null;
  return verdict;
}

/**
 * Spustí celý beh: prihlásenie → baseline → nahratie CSV → over bezpečné
 * nastavenia → spustenie importu → čítanie výsledku z Logu (baseline +
 * expectedRows atribúcia, `log-attribution.ts`). Vyhodí, keď sa NEDÁ ani
 * prihlásiť/nájsť formulár (fail-loud, nič sa neposlalo); vráti
 * `ok: false` s vysvetlením, keď sa CSV odoslalo, ale výsledok nemožno
 * potvrdiť ako úspech (nejednoznačné/zlyhané/nečitateľné).
 */
export async function runShoptetImport(options: RunShoptetImportOptions): Promise<ShoptetImportOutcome> {
  const { config, csv, expectedRows } = options;
  const executablePath = options.executablePath ?? resolveChromiumExecutablePath();
  let browser: Browser | undefined;
  const tmpDir = await mkdtemp(join(tmpdir(), "shoptet-writeback-"));
  const csvPath = join(tmpDir, "import.csv");
  try {
    await writeFile(csvPath, csv);
    browser = await chromium.launch({
      headless: options.headless ?? true,
      ...(executablePath === undefined ? {} : { executablePath }),
      // --no-sandbox/--disable-setuid-sandbox: bežíme ako non-root `node` v
      // kontajneri bez extra capabilities, Chromiov sandbox by inak zlyhal na
      // štarte. --disable-dev-shm-usage: kontajnerov malý /dev/shm by inak
      // Chromium prehltol pri väčších stránkach. --disable-gpu: žiadny GPU v
      // kontajneri — overené naživo proti apk-nainštalovanému Alpine
      // chromiu pri návrhu #122 (bez tejto vlajky Chromium chrlí neškodné,
      // ale hlučné ANGLE/Vulkan chybové riadky do stderr).
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();

    await login(page, config);
    const baseline = await captureBaseline(page, config);
    log.info({ baseline: baseline === null ? null : "prítomný" }, "shoptet write-back: baseline Logu zachytený");

    await page.goto(config.importUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    const fileInput = page.locator('input[type="file"][name="file"]');
    if ((await fileInput.count()) === 0) {
      throw new Error(`Nenašiel som import formulár (file input) na ${page.url()}`);
    }
    // Priame `setInputFiles` na skrytý `<input>` NESTAČÍ — Shoptetov widget
    // (React) drží "súbor vybraný" stav sám v sebe, naviazaný na natívny
    // file-chooser dialóg spustený VIDITEĽNÝM tlačidlom "Vyberte súbor", nie
    // na `change` event skrytého inputu (rovnaké zistenie ako sesterský
    // `scripts/shoptet_import.py`'s `_do_import`: "Shoptet widget inak súbor
    // nezaregistruje" — overené naživo pri návrhu #122: priamy
    // `setInputFiles` nechal formulár tichoodmietnuť odoslanie, `buttonImport`
    // klik nikdy nenavigoval na Log). Port toho istého postupu: počkaj na
    // `filechooser` event VYVOLANÝ klikom na viditeľné tlačidlo, súbor nastav
    // na ZACHYTENÝ chooser objekt.
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.locator('button:has-text("Vyberte súbor")').first().click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(csvPath);
    await ensureSafeSettings(page);

    await page.getByTestId("buttonImport").click();
    await page.waitForURL(/import-produktov\/log/, { timeout: 120_000 });
    await page.waitForLoadState("networkidle");

    const resultText = await pollForResult(
      page,
      config,
      baseline,
      expectedRows,
      options.resultPollRetries ?? 6,
      options.resultPollWaitMs ?? 2000,
    );
    const parsed = parseImportLog(resultText);
    const ok = resultText !== null && resultExitCode(parsed) === 0;
    log.info(
      { ok, processed: parsed.processed, updated: parsed.updated, failed: parsed.failed },
      "shoptet write-back: výsledok importu prečítaný",
    );
    return { ok, processed: parsed.processed, updated: parsed.updated, failed: parsed.failed, errorDetail: parsed.errorDetail, rawResultText: resultText };
  } finally {
    await browser?.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}
