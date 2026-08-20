import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AddressInfo } from "node:net";

/**
 * Falošný Shoptet — imituje LEN tvar, ktorý `playwright-import.ts` naozaj
 * ovláda (prihlásenie, import formulár, Log), aby sa dala overiť CELÁ
 * automatizácia reálnym Chromiom bez toho, aby sa čokoľvek nahralo do
 * skutočného Shoptetu (issue 122's testová požiadavka). Tvar stránok/
 * selektorov zodpovedá SKUTOČNÉMU Shoptet adminu overenému naživo pri
 * návrhu tohto ticketu (login page = "/admin/", žiadny presmerovací
 * URL-rozdiel medzi úspechom/neúspechom — preto `playwright-import.ts`
 * kontroluje PRÍTOMNOSŤ prihlasovacieho formulára, nie URL substring).
 */

const SAFE_RADIO_LABEL = "Nemeniť produkty a varianty, ktoré nie sú obsiahnuté v importovanom súbore.";
const URL_BY_NAME_LABEL = "Zmeňte adresu URL produktu podľa názvu produktu.";
const COOKIE_NAME = "sid";

export type FixtureOutcomeMode = "success" | "partial" | "hard-error";

export interface ShoptetFixtureOptions {
  readonly user: string;
  readonly password: string;
  /** Import formulár VYNECHÁ bezpečný radio — na overenie, že
   * `playwright-import.ts` odmietne pokračovať namiesto tichého importu bez
   * neho (fail-closed). */
  readonly omitSafeRadio?: boolean;
}

export interface ShoptetFixture {
  readonly baseUrl: string;
  setOutcome(mode: FixtureOutcomeMode): void;
  readonly logEntryCount: () => number;
  /** Seeds ONE pre-existing Log entry, as if a previous import already ran —
   * a real Shoptet instance's Log is NEVER empty (this shop's own Log is
   * already past #12000, confirmed live at #122's design), so every real
   * write-back run captures a NON-NULL baseline. `pickResultRow`
   * (log-attribution.ts) deliberately fail-closes on a null baseline (a
   * genuinely unreadable Log page) — tests exercise the real, common path by
   * seeding this, matching production instead of the never-happens "log
   * truly empty" edge case. */
  seedPastEntry(): void;
  /** issue 387 E7: makes the NEXT import attempt's `/admin/import-produktov/`
   * page render WITHOUT the safe-mode radio — one-shot (consumed on the next
   * `GET`, then reverts to normal), so `ensureSafeSettings` (`playwright-
   * import.ts`) throws (a genuine HARD failure, not a soft `{ok:false}` Log
   * result) on that ONE attempt only. Lets a test prove that a hard failure
   * in ONE of two sequential import calls (`run-writeback-sequence.ts`) does
   * NOT prevent the OTHER from being genuinely attempted — a static
   * `omitSafeRadio` (constructor option, above) would trip on EVERY attempt
   * against the same fixture, making the two calls indistinguishable. */
  failNextImportFormOnce(): void;
  /** issue 465: reálny Shoptet import hlási `Zlyhanie variantov: 1` (soft
   * partial → `run-writeback.ts` `!outcome.ok` → nič sa neoznačí), keď nahrané
   * CSV obsahuje `code` produktu/variantu, ktorý už v Shoptete NEEXISTUJE
   * (variant odstránený). Globálny `setOutcome("partial")` to nevie vyjadriť
   * per-kódovo — a práve „dávka padne KVÔLI mŕtvemu kódu, zdravý súrodenec
   * ostane nezapísaný" je jadro tohto ticketu. Nastaví, že KAŽDÝ import,
   * ktorého CSV obsahuje `code`, dopadne `partial`; keď kód v CSV nie je
   * (oprava ho odfiltrovala), import prejde normálne. */
  failImportWhenCsvContainsCode(code: string): void;
  close(): Promise<void>;
}

function loginPage(failed: boolean): string {
  return `<!doctype html><html><body>
    ${failed ? "<p>Nesprávne prihlasovacie údaje</p>" : ""}
    <form method="post" action="/admin/do-login">
      <input placeholder="E-mail" name="email" />
      <input placeholder="Vaše heslo" name="password" type="password" />
      <button type="submit">Prihlásenie</button>
    </form>
  </body></html>`;
}

function dashboardPage(): string {
  return `<!doctype html><html><body><h1>Nástenka</h1></body></html>`;
}

function importPage(omitSafeRadio: boolean): string {
  const radio = omitSafeRadio
    ? ""
    : `<label><input type="radio" name="mode" value="safe" />${SAFE_RADIO_LABEL}</label>`;
  // Skrytý file input + viditeľné tlačidlo, ktoré ho programovo "kliká" —
  // rovnaký tvar ako reálny Shoptet (overené naživo pri návrhu #122: input
  // má `hidden`, viditeľné je len tlačidlo "Vyberte súbor"; `playwright-
  // import.ts` preto musí ísť cez `filechooser` event, nikdy priamy
  // `setInputFiles` na skrytý input).
  return `<!doctype html><html><body>
    <form method="post" action="/admin/import-produktov/do-import" enctype="multipart/form-data">
      <input type="file" name="file" id="fileInput" hidden />
      <button type="button" onclick="document.getElementById('fileInput').click()">Vyberte súbor</button>
      ${radio}
      <label><input type="checkbox" name="urlByName" />${URL_BY_NAME_LABEL}</label>
      <button type="submit" data-testid="buttonImport">Importovať</button>
    </form>
  </body></html>`;
}

function logPage(entries: readonly string[]): string {
  const rows = entries.map((e) => `<tr><td>${e}</td></tr>`).join("");
  return `<!doctype html><html><body><table><tr><td>Dátum</td><td>Výsledok</td></tr>${rows}</table></body></html>`;
}

function countCsvDataRows(csvText: string): number {
  // strip BOM, split CRLF/LF, drop header + trailing empty line
  const withoutBom = csvText.replace(/^\uFEFF/, "");
  return withoutBom.split(/\r?\n/).filter((l) => l.length > 0).length - 1;
}

export async function startShoptetFixture(options: ShoptetFixtureOptions): Promise<ShoptetFixture> {
  const app = new Hono();
  let entries: string[] = [];
  let nextId = 100;
  let outcome: FixtureOutcomeMode = "success";
  let failNextImportForm = false; // issue 387 E7 — one-shot, see failNextImportFormOnce() below
  let rejectCodeInCsv: string | null = null; // issue 465 — see failImportWhenCsvContainsCode() below

  app.get("/admin/", (c) => {
    const cookie = getCookie(c, COOKIE_NAME);
    return c.html(cookie === "ok" ? dashboardPage() : loginPage(false));
  });

  app.post("/admin/do-login", async (c) => {
    const body = await c.req.parseBody();
    const email = body["email"];
    const password = body["password"];
    if (email === options.user && password === options.password) {
      setCookie(c, COOKIE_NAME, "ok", { httpOnly: true, path: "/" });
      return c.redirect("/admin/", 303);
    }
    return c.redirect("/admin/", 303);
  });

  app.get("/admin/import-produktov/", (c) => {
    if (getCookie(c, COOKIE_NAME) !== "ok") return c.redirect("/admin/", 303);
    if (failNextImportForm) {
      failNextImportForm = false; // one-shot — consumed, next request is normal again
      return c.html(importPage(true));
    }
    return c.html(importPage(options.omitSafeRadio ?? false));
  });

  app.get("/admin/import-produktov/log/", (c) => {
    if (getCookie(c, COOKIE_NAME) !== "ok") return c.redirect("/admin/", 303);
    return c.html(logPage(entries));
  });

  app.post("/admin/import-produktov/do-import", async (c) => {
    if (getCookie(c, COOKIE_NAME) !== "ok") return c.redirect("/admin/", 303);
    const body = await c.req.parseBody();
    const file = body["file"];
    const text = file instanceof File ? await file.text() : "";
    const rowCount = countCsvDataRows(text);
    const id = nextId;
    nextId += 1;
    const date = "01.08.2026 10:00";
    // issue 465: mŕtvy kód (variant odstránený zo Shoptetu) prítomný v CSV →
    // reálny Shoptet import hlási failed:1 nad celou dávkou (soft partial).
    const effectiveOutcome: FixtureOutcomeMode =
      rejectCodeInCsv !== null && text.includes(rejectCodeInCsv) ? "partial" : outcome;
    let resultText: string;
    if (effectiveOutcome === "success") {
      resultText = `Spracované: ${String(rowCount)}. Upravené: ${String(rowCount)}. Zlyhanie variantov: 0.`;
    } else if (effectiveOutcome === "partial") {
      resultText = `Spracované: ${String(rowCount)}. Upravené: ${String(rowCount - 1)}. Zlyhanie variantov: 1.`;
    } else {
      resultText = "Chyba | Číslo riadku: 2 - Data in column code are not unique";
    }
    entries = [`#${String(id)} ${date} ${resultText}`, ...entries];
    return c.redirect("/admin/import-produktov/log/", 303);
  });

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => {
      resolve(s as unknown as import("node:http").Server);
    });
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    setOutcome: (mode) => {
      outcome = mode;
    },
    logEntryCount: () => entries.length,
    seedPastEntry: () => {
      const id = nextId;
      nextId += 1;
      entries = [`#${String(id)} 01.08.2026 09:00 Spracované: 9. Upravené: 9. Zlyhanie variantov: 0.`, ...entries];
    },
    failNextImportFormOnce: () => {
      failNextImportForm = true;
    },
    failImportWhenCsvContainsCode: (code) => {
      rejectCodeInCsv = code;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
