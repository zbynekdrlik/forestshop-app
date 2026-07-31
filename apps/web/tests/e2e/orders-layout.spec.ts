import { expect, test, type ConsoleMessage } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze

// issue 107: majiteľ, live nameraná chyba po nasadení issue 105 — orezaný
// text v STAV (bod 1), príliš úzke pole POZNÁMKY (bod 2). Vlastný súbor +
// vlastný izolovaný účet — `orders.spec.ts` je už na eslint `max-lines: 400`
// hranici (`.claude/rules/frontend-design.md`'s zavedený vzor), a balík
// zdieľaného `e2e@forestshop.sk` je na hranici `MAX_ATTEMPTS`
// (`scripts/e2e-setup.ts`'s komentár k `E2E_ROZLOZENIE_EMAIL`).
const E2E_ROZLOZENIE_EMAIL = "e2e-rozlozenie@forestshop.sk";

const jeOcakavane = (m: ConsoleMessage): boolean =>
  m.location().url.includes("/api/me") && m.text().includes("401");

test("STAV je celý čitateľný a POZNÁMKY pole je dosť široké na všetkých 4 šírkach, riadky bez priradenia dodávateľa ostávajú kompaktné, konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill(E2E_ROZLOZENIE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  await page.waitForSelector(".orders-table");

  for (const width of [1280, 1440, 1600, 1920]) {
    await page.setViewportSize({ width, height: 900 });

    // issue 107 bod 1: KAŽDÁ <option> stavu (nie len tá aktuálne vybraná)
    // musí byť celá viditeľná — `appearance: none` (`app.css`'s
    // `.ord-state-select`) spravilo priestor na text DETERMINISTICKÝ
    // (`clientWidth - padding - border`, žiadna skrytá natívna šípka), takže
    // test už nepotrebuje hádať jej šírku.
    const orezaneStavy = await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>(".ord-state-select");
      if (!select) return { chyba: "no select found" };
      const rect = select.getBoundingClientRect();
      const cs = getComputedStyle(select);
      const dostupne =
        rect.width -
        parseFloat(cs.paddingLeft) -
        parseFloat(cs.paddingRight) -
        parseFloat(cs.borderLeftWidth) -
        parseFloat(cs.borderRightWidth);
      const merac = document.createElement("span");
      merac.style.visibility = "hidden";
      merac.style.position = "absolute";
      merac.style.whiteSpace = "nowrap";
      merac.style.font = cs.font;
      document.body.appendChild(merac);
      const orezane: string[] = [];
      for (const option of [...select.options]) {
        merac.textContent = option.textContent;
        const potrebne = merac.getBoundingClientRect().width;
        if (potrebne > dostupne) {
          orezane.push(`"${option.textContent}" (${String(Math.ceil(potrebne))}px text vs ${String(Math.floor(dostupne))}px k dispozícii)`);
        }
      }
      merac.remove();
      return { orezane };
    });
    expect(orezaneStavy.orezane, `orezané stavy pri ${String(width)}px`).toEqual([]);

    // issue 107 bod 2: pole na poznámku >= 160px pri 1280px, tlačidlo 💾 na
    // TOM ISTOM riadku (nesmie sa vrátiť k zalomeniu z issue 105).
    const poznamky = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[data-testid^="comment-input-"]');
      if (!input) return { chyba: "no comment input found" };
      const button = input.closest(".ord-comment-cell")?.querySelector("button");
      const inputRect = input.getBoundingClientRect();
      const buttonRect = button?.getBoundingClientRect();
      return {
        width: inputRect.width,
        naTomIstomRiadku: buttonRect !== undefined && Math.abs(inputRect.top - buttonRect.top) < 3,
      };
    });
    expect(poznamky.naTomIstomRiadku, `tlačidlo 💾 na inom riadku ako pole pri ${String(width)}px`).toBe(true);
    if (width === 1280) {
      expect(poznamky.width, "šírka poľa na poznámku pri 1280px").toBeGreaterThanOrEqual(160);
    }

    // issue 107 bod 2 (regresia issue 105): riadky BEZ bloku priradenia
    // dodávateľa (žiadny živý riadok ho dnes nemá) ostávajú kompaktné —
    // riadky S ním (zriedkavé, `supplierAssignable`) sú vyňaté zámerne: aj
    // živá produkcia bežne prekračuje ~95px kvôli dlhým názvom produktov
    // (`.claude/rules/frontend-design.md`), takže tento test overuje presne
    // to, čo je v scope tohto ticketu — POZNÁMKY stĺpec už nespôsobuje
    // zalomenie vstup+tlačidlo, nie univerzálny strop na VŠETKY možné riadky.
    const vysokeKompaktneRiadky = await page.evaluate(() => {
      return [...document.querySelectorAll(".order-row")]
        .filter((r) => r.querySelector('[data-testid^="supplier-assign-cell-"]') === null)
        .map((r) => r.getBoundingClientRect().height)
        .filter((h) => h > 100);
    });
    expect(vysokeKompaktneRiadky, `príliš vysoké riadky pri ${String(width)}px`).toEqual([]);
  }

  expect(chyby).toEqual([]);
});
