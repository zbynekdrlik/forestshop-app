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

    // issue 161: `<select>` (a issue 107 bod 1's šípkový problém, ktorý
    // riešila) nahradili 4 tlačidlá — KAŽDÉ musí zobraziť svoj CELÝ text
    // (zalomenie na 2 riadky je OK, orezanie/vodorovné pretečenie nie).
    const orezaneStavy = await page.evaluate(() => {
      const orezane: string[] = [];
      for (const btn of document.querySelectorAll<HTMLElement>(".ord-state-btn")) {
        if (btn.scrollWidth > btn.clientWidth + 1) {
          orezane.push(`"${btn.textContent}" (scrollWidth ${String(btn.scrollWidth)}px vs clientWidth ${String(btn.clientWidth)}px)`);
        }
      }
      return orezane;
    });
    expect(orezaneStavy, `orezané stavové tlačidlá pri ${String(width)}px`).toEqual([]);

    // issue 107 bod 2: pole na poznámku >= 160px pri 1280px, tlačidlo 💾 na
    // TOM ISTOM riadku (nesmie sa vrátiť k zalomeniu z issue 105).
    const poznamky = await page.evaluate(() => {
      // issue 150: pole je odteraz `<textarea>` (predtým `<input>`) —
      // selektor bez tagu, aby fungoval po zmene elementu bez ďalšej úpravy.
      const input = document.querySelector<HTMLTextAreaElement>('[data-testid^="comment-input-"]');
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
    // dodávateľa ostávajú kompaktné — riadky S ním (zriedkavé,
    // `supplierAssignable`) sú vyňaté zámerne. AKTUALIZÁCIA (issue 127,
    // 2026-08-01): "žiadny živý riadok ho dnes nemá" (pôvodný komentár tu)
    // je ZASTARANÉ — produkcia má dnes 3 také riadky (naživo overené proti
    // `vychod@varos.sk`), preto sa toto vylúčenie z výškovej kontroly stále
    // uplatňuje aj naživo, nielen teoreticky. Aj živá produkcia bežne
    // prekračuje ~95px kvôli dlhým názvom produktov
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

    // issue 163: majiteľ, deliaca čiara riadku nelícuje pod bunkou s
    // odkazom na dodávateľa — príčina bola `display:flex` priamo na
    // `td.ord-supplier-merged` (odstránené, `app.css`), ktorý bunku
    // zmenšoval na výšku VLASTNÉHO obsahu namiesto skutočnej výšky riadku
    // (tú si vynucujú iné, vyššie bunky), takže jej border-bottom sedel
    // vyššie než u susedných buniek. Kontrola: PRE KAŽDÝ viditeľný riadok
    // musí spodný okraj tejto bunky lícovať so spodným okrajom riadku
    // (±1px, subpixelové zaokrúhlenie pri neceločíselnom zoome/DPR).
    const nezarovnaneDelice = await page.evaluate(() => {
      return [...document.querySelectorAll<HTMLElement>("tr[data-testid^='order-line-']")]
        .map((riadok) => {
          const bunka = riadok.querySelector<HTMLElement>("td.ord-supplier-merged");
          if (bunka === null) return null;
          return Math.abs(bunka.getBoundingClientRect().bottom - riadok.getBoundingClientRect().bottom);
        })
        .filter((rozdiel): rozdiel is number => rozdiel !== null && rozdiel > 1);
    });
    expect(nezarovnaneDelice, `nezarovnané deliace čiary pod bunkou dodávateľa pri ${String(width)}px`).toEqual([]);

    // issue 111 body 1+2: číslo objednávky ANI kód produktu sa nesmú
    // zalomiť na viac riadkov, na ŽIADNEJ zo 4 šírok — kontroluje sa AJ
    // `white-space: nowrap` (mechanizmus, ktorý garantuje toto natrvalo, aj
    // pre BUDÚCI dlhší obsah, nie len dnešný zmeraný obsah fixtúry) AJ
    // skutočný počet zalomených riadkov (`getClientRects().length > 1` —
    // funguje pre `<a>`/text-node vo VNÚTRI bunky; na `<td>` samotnej by to
    // vždy vrátilo 1, keďže je to blokový box, nie inline text).
    const zalomeneObjednavky = await page.evaluate(() => {
      const odkazy = [...document.querySelectorAll<HTMLAnchorElement>(".ord-order-cell a.ord-admin-link")];
      const prvy = odkazy.at(0);
      return {
        pocetZalomenych: odkazy.filter((a) => a.getClientRects().length > 1).length,
        whiteSpace: prvy !== undefined ? getComputedStyle(prvy).whiteSpace : null,
      };
    });
    expect(zalomeneObjednavky.pocetZalomenych, `zalomené čísla objednávky pri ${String(width)}px`).toBe(0);
    expect(zalomeneObjednavky.whiteSpace, `.ord-admin-link white-space pri ${String(width)}px`).toBe("nowrap");

    // issue 111 bod 2's `.ord-code-cell` zalomenie kontrola je ODSTRÁNENÁ —
    // issue 117 celý stĺpec kódu produktu zrušilo (majiteľ nepoužíva), takže
    // `.ord-code-cell` už v DOM-e vôbec neexistuje.

    // issue 127: odznak veku objednávky (`.ord-stale-badge`) sa CELOU šírkou
    // musí zmestiť do svojej bunky (`.col-date`) — pred touto opravou
    // pretŕčal o ~22px pri 1280px do vedľajšieho stĺpca POZNÁMKY. Objednávka
    // 9002 (`scripts/e2e-setup.ts`) má `placedAt` hlboko v minulosti, takže
    // odznak sa vždy vykreslí.
    const staleOdznaky = await page.evaluate(() => {
      return [...document.querySelectorAll<HTMLElement>("[data-testid^='stale-badge-']")].map((odznak) => {
        const td = odznak.closest("td");
        if (td === null) return { spill: null, scrollOverflow: null };
        const odznakRect = odznak.getBoundingClientRect();
        const tdRect = td.getBoundingClientRect();
        return {
          spill: odznakRect.right - tdRect.right,
          scrollOverflow: td.scrollWidth > td.clientWidth,
        };
      });
    });
    expect(staleOdznaky.length, `žiadny stale-badge nájdený pri ${String(width)}px`).toBeGreaterThan(0);
    for (const { spill, scrollOverflow } of staleOdznaky) {
      expect(spill, `odznak pretŕča svoju bunku pri ${String(width)}px`).not.toBeNull();
      expect(spill as number, `odznak pretŕča svoju bunku pri ${String(width)}px`).toBeLessThanOrEqual(0);
      expect(scrollOverflow, `bunka odznaku posúva obsah pri ${String(width)}px`).toBe(false);
    }

    // issue 111 bod 5: pri 1280px sa žiadna `.orders-table-wrap` skupina
    // nesmie posúvať vodorovne (predtým 💾 tlačidlo bolo za viditeľným
    // okrajom, kým manažér nescrolloval).
    if (width === 1280) {
      const pretekajuceObaly = await page.evaluate(() => {
        return [...document.querySelectorAll(".orders-table-wrap")].filter((w) => w.scrollWidth > w.clientWidth)
          .length;
      });
      expect(pretekajuceObaly, "pretekajúce .orders-table-wrap pri 1280px").toBe(0);

      const strankaSaPosuva = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(strankaSaPosuva, "stránka sa vodorovne posúva pri 1280px").toBe(false);
    }
  }

  // issue 163: rovnaká deliaca-čiara kontrola aj pri ZAPNUTOM prepínači
  // "skryť vybavené" — fix je štrukturálny (CSS na `<td>`), nie závislý od
  // POČTU vykreslených riadkov, ale ticket to explicitne žiada overiť oboma
  // stavmi prepínača.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId("orders-hide-resolved-toggle").click();
  const nezarovnaneDeliceSkryte = await page.evaluate(() => {
    return [...document.querySelectorAll<HTMLElement>("tr[data-testid^='order-line-']")]
      .map((riadok) => {
        const bunka = riadok.querySelector<HTMLElement>("td.ord-supplier-merged");
        if (bunka === null) return null;
        return Math.abs(bunka.getBoundingClientRect().bottom - riadok.getBoundingClientRect().bottom);
      })
      .filter((rozdiel): rozdiel is number => rozdiel !== null && rozdiel > 1);
  });
  expect(nezarovnaneDeliceSkryte, "nezarovnané deliace čiary pri zapnutom 'skryť vybavené'").toEqual([]);
  // Vrátiť prepínač do pôvodného stavu — iné súbežne bežiace e2e spec súbory
  // (`.claude/rules/testing.md`'s "skryť vybavené" je GLOBÁLNY localStorage
  // preferencia) nespoliehajú na tento konkrétny účet, ale je to čistejšie.
  await page.getByTestId("orders-hide-resolved-toggle").click();

  expect(chyby).toEqual([]);
});
