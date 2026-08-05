import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze

// issue 107: majiteľ, live nameraná chyba po nasadení issue 105 — orezaný
// text v STAV (bod 1), príliš úzke pole POZNÁMKY (bod 2). Vlastný súbor +
// vlastný izolovaný účet — `orders.spec.ts` je už na eslint `max-lines: 400`
// hranici (`.claude/rules/frontend-design.md`'s zavedený vzor), a balík
// zdieľaného `e2e@forestshop.sk` je na hranici `MAX_ATTEMPTS`
// (`scripts/e2e-setup.ts`'s komentár k `E2E_ROZLOZENIE_EMAIL`).
const E2E_ROZLOZENIE_EMAIL = "e2e-rozlozenie@forestshop.sk";

test("STAV je celý čitateľný a POZNÁMKY pole je dosť široké na všetkých 4 šírkach, riadky bez priradenia dodávateľa ostávajú kompaktné, konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
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
    // AKTUALIZÁCIA (issue 171, 2026-08-02): strop 115px→105px — zákaznícka
    // poznámka (`remark`) sa presunula z bunky POZNÁMKY do bunky PRODUKTU
    // (pod meno produktu), takže bunka POZNÁMKY teraz nesie len DVA
    // stackované riadky (`.ord-shop-remark-cell`/`.ord-comment-cell`)
    // namiesto pôvodných troch. Riadok, čo nesie VŠETKY TRI poznámky naraz
    // (fixtúra 9001, `scripts/e2e-setup.ts`), teraz naživo meria ~98.19px
    // pri 1280px (predtým ~108.5px, keď boli všetky tri v jednej bunke) —
    // znovu zmerané throwaway skriptom (`page.evaluate` logujúci reálne
    // `getBoundingClientRect().height` proti lokálnym dev serverom, rovnaká
    // metodika ako issue 105/107/111/127/164), NIE len odhadnuté. 105px
    // necháva malú rezervu nad nameraným 98.19px bez toho, aby maskoval
    // skutočné zalomenie (to by strop prehodilo o desiatky px, nie
    // jednotky).
    const vysokeKompaktneRiadky = await page.evaluate(() => {
      return [...document.querySelectorAll(".order-row")]
        .filter((r) => r.querySelector('[data-testid^="supplier-assign-cell-"]') === null)
        .map((r) => r.getBoundingClientRect().height)
        .filter((h) => h > 105);
    });
    expect(vysokeKompaktneRiadky, `príliš vysoké riadky pri ${String(width)}px`).toEqual([]);

    // issue 163: majiteľ, deliaca čiara riadku nelícuje pod bunkou s
    // odkazom na dodávateľa (opravené) a NESKÔR (znovu otvorené) aj pod
    // bunkou poznámok — obe mali rovnakú príčinu: `display:flex` priamo na
    // `<td>` (odstránené, `app.css`), ktorý bunku zmenšoval na výšku
    // VLASTNÉHO obsahu namiesto skutočnej výšky riadku (tú si vynucujú iné,
    // vyššie bunky), takže jej border-bottom sedel vyššie než u susedných
    // buniek. Kontrola je ZOVŠEOBECNENÁ na VŠETKY `<td>` v riadku (nie len
    // konkrétnu triedu) — presne to, čo ticket žiada ("all td of a row share
    // the same getBoundingClientRect().bottom") a čo je future-proof pre
    // AKÝKOĽVEK ďalší stĺpec, čo by túto chybu v budúcnosti zopakoval.
    // Tolerancia ±1px, subpixelové zaokrúhlenie pri neceločíselnom zoome/DPR.
    const nezarovnaneDelice = await page.evaluate(() => {
      const rozdiely: number[] = [];
      for (const riadok of document.querySelectorAll<HTMLElement>("tr[data-testid^='order-line-']")) {
        const riadokBottom = riadok.getBoundingClientRect().bottom;
        for (const bunka of riadok.querySelectorAll<HTMLElement>("td")) {
          const rozdiel = Math.abs(bunka.getBoundingClientRect().bottom - riadokBottom);
          if (rozdiel > 1) rozdiely.push(rozdiel);
        }
      }
      return rozdiely;
    });
    expect(nezarovnaneDelice, `nezarovnané deliace čiary v riadku pri ${String(width)}px`).toEqual([]);

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

    // issue 204: majiteľ, "link dodavatel a spolu sa prekrivaju je to nepekne
    // 1 ksΣ spolu 1 ks 🔗" — pilulka so súčtom kusov sa vykresľovala INLINE za
    // množstvom a s `white-space: nowrap` pretiekla o ~49px za pravý okraj
    // svojej 54px bunky (naživo namerané na produkcii) presne nad ikonku
    // odkazu na dodávateľa v susednom stĺpci. Rovnaká kontrola ako pri
    // odznaku veku objednávky (issue 127) — pilulka sa musí CELÁ zmestiť do
    // svojej bunky na KAŽDEJ zo 4 šírok.
    const pretekajuceSucty = await page.evaluate(() => {
      return [...document.querySelectorAll<HTMLElement>("[data-testid^='qty-total-']")].map((pilulka) => {
        const td = pilulka.closest("td");
        if (td === null) return { spill: null, scrollOverflow: null };
        return {
          spill: pilulka.getBoundingClientRect().right - td.getBoundingClientRect().right,
          scrollOverflow: td.scrollWidth > td.clientWidth,
        };
      });
    });
    expect(pretekajuceSucty.length, `žiadna pilulka súčtu nenájdená pri ${String(width)}px`).toBeGreaterThan(0);
    for (const { spill, scrollOverflow } of pretekajuceSucty) {
      expect(spill, `pilulka súčtu pretŕča svoju bunku pri ${String(width)}px`).not.toBeNull();
      expect(spill as number, `pilulka súčtu pretŕča svoju bunku pri ${String(width)}px`).toBeLessThanOrEqual(0);
      expect(scrollOverflow, `bunka s množstvom posúva obsah pri ${String(width)}px`).toBe(false);
    }

    // issue 214: pilulka sa síce do bunky ZMESTÍ (kontrola vyššie), ale
    // predtým sa jej vykreslilo len 16 px zo 49 px obsahu — `text-overflow:
    // ellipsis` ju orezal na "Σ…" a majiteľ z nej neprečítal nič ("teraz
    // vobec nie je citatelne to spolu produkty"). Kontrola vyššie to
    // nezachytí, lebo orezaný prvok svoju bunku nikdy nepretečie — treba
    // merať vlastné orezanie pilulky, na KAŽDEJ zo 4 šírok.
    const orezaneSucty = await page.evaluate(() => {
      return [...document.querySelectorAll<HTMLElement>("[data-testid^='qty-total-']")].map((pilulka) => ({
        text: pilulka.textContent.trim(),
        orezane: pilulka.scrollWidth > pilulka.clientWidth + 1,
      }));
    });
    for (const { text, orezane } of orezaneSucty) {
      expect(orezane, `pilulka súčtu "${text}" je orezaná pri ${String(width)}px`).toBe(false);
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

  // issue 171: majiteľ, "poznamka zakaznika daj pod text produktu" —
  // zákaznícka poznámka (🛈) objednávky 9001 (`scripts/e2e-setup.ts`, variant
  // "4859/46" pod dodávateľom DODAVATEL-TEST-1) musí byť v TOM ISTOM `<td>`
  // ako meno produktu, NIE v zlúčenej bunke POZNÁMKY (`shop-remark-cell`/
  // `comment-cell`), a vizuálne odlíšená (menšie písmo než meno produktu).
  await page.setViewportSize({ width: 1280, height: 900 });
  const umiestnenie = await page.evaluate(() => {
    // `scripts/e2e-setup.ts`'s objednávka 9001 má JEDINÚ zákaznícku poznámku
    // ("Prosím doručiť len v piatok") — hľadať podľa OBSAHU, nie podľa
    // prvého `[data-testid^='remark-cell-']` v DOM poradí (ten obalový div sa
    // vykresľuje na KAŽDOM riadku, aj bez poznámky, takže prvý v poradí by
    // nemusel patriť riadku 9001).
    const remarkBunka = [...document.querySelectorAll('[data-testid^="remark-cell-"]')].find((el) =>
      el.textContent.includes("Prosím doručiť len v piatok"),
    );
    const produktBunka =
      [...document.querySelectorAll("td")].find((td) => td.textContent.includes("Nohavice Hart Wild-T")) ?? null;
    const poznamkyBunka = [...document.querySelectorAll('[data-testid^="shop-remark-cell-"]')].find((el) =>
      el.textContent.includes("Sklad potvrdil, pripravené na vyzdvihnutie"),
    );
    const najdeneVsetky = remarkBunka !== undefined && produktBunka !== null && poznamkyBunka !== undefined;
    const remarkTd = najdeneVsetky ? remarkBunka.closest("td") : null;
    return {
      najdeneVsetky,
      vProduktovejBunke: najdeneVsetky && remarkTd === produktBunka,
      vPoznamkovejBunke: najdeneVsetky && remarkTd === poznamkyBunka.closest("td"),
      fontSizeRemark: najdeneVsetky
        ? getComputedStyle(remarkBunka.querySelector(".ord-remark") ?? remarkBunka).fontSize
        : null,
      fontSizeProdukt: najdeneVsetky ? getComputedStyle(produktBunka).fontSize : null,
    };
  });
  expect(umiestnenie.najdeneVsetky, "chýbajúci prvok pri kontrole umiestnenia poznámky zákazníka").toBe(true);
  expect(umiestnenie.vProduktovejBunke, "poznámka zákazníka nie je v bunke produktu").toBe(true);
  expect(umiestnenie.vPoznamkovejBunke, "poznámka zákazníka je stále v zlúčenej bunke POZNÁMKY").toBe(false);
  expect(umiestnenie.fontSizeRemark, "poznámka zákazníka nie je vizuálne menšia než meno produktu").not.toBe(
    umiestnenie.fontSizeProdukt,
  );

  // issue 163: rovnaká (zovšeobecnená, VŠETKY `<td>`) deliace-čiary kontrola
  // aj pri ZAPNUTOM prepínači "skryť vybavené" — fix je štrukturálny (CSS na
  // `<td>`), nie závislý od POČTU vykreslených riadkov, ale ticket to
  // explicitne žiada overiť oboma stavmi prepínača.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId("orders-hide-resolved-toggle").click();
  const nezarovnaneDeliceSkryte = await page.evaluate(() => {
    const rozdiely: number[] = [];
    for (const riadok of document.querySelectorAll<HTMLElement>("tr[data-testid^='order-line-']")) {
      const riadokBottom = riadok.getBoundingClientRect().bottom;
      for (const bunka of riadok.querySelectorAll<HTMLElement>("td")) {
        const rozdiel = Math.abs(bunka.getBoundingClientRect().bottom - riadokBottom);
        if (rozdiel > 1) rozdiely.push(rozdiel);
      }
    }
    return rozdiely;
  });
  expect(nezarovnaneDeliceSkryte, "nezarovnané deliace čiary pri zapnutom 'skryť vybavené'").toEqual([]);
  // Vrátiť prepínač do pôvodného stavu — iné súbežne bežiace e2e spec súbory
  // (`.claude/rules/testing.md`'s "skryť vybavené" je GLOBÁLNY localStorage
  // preferencia) nespoliehajú na tento konkrétny účet, ale je to čistejšie.
  await page.getByTestId("orders-hide-resolved-toggle").click();

  expect(chyby).toEqual([]);
});

// issue 263: majiteľ (po nasadení issue 259), doslovne "ja potrebujem aby to
// bolo ako minule - že ten riadok kde su firmy - tak že tam sa menia tie
// farby nie na tých produktoch". Farba patrí na filtračné čipy dodávateľov
// (`.chip`, HLAVNÝ nosič) a na hlavičku skupiny v zozname (`.toorder-supplier`,
// VEDĽAJŠÍ nosič) — NIKDY na riadky produktov (`tr.order-row`, issue 259's
// odstránené `.line-resolved`/`.line-unresolved`). Presné hex hodnoty zo
// starej appky (`app.css`'s `:root` komentár vysvetľuje prečo): zelená
// `#6CAB68`=rgb(108,171,104) nespracované, červená `#D14D3B`=rgb(209,77,59)
// vybavené, oranžová `#DDA43C`=rgb(221,164,60) práve vybraný filter (prebíja
// oboje). Test beží pod TÝM ISTÝM `e2e-rozlozenie@forestshop.sk` účtom ako
// test vyššie v tomto súbore (dáta objednávok sú GLOBÁLNE, nie per-účet,
// `.claude/rules/testing.md`) — DODAVATEL-TEST-1 (`orders.spec.ts`'s
// komentár: 1 riadok v stave "caka_sa", teda `isLineResolved` vybavený) a
// DODAVATEL-TEST-2 (2 riadky v predvolenom "objednane", nevybavené) sú OBE
// existujúce fixtúrové skupiny — žiadna mutácia dát, žiadne riziko kolízie
// so súbežne bežiacimi spec súbormi.
test("filtračné čipy dodávateľov a hlavička skupiny sú zelené/červené/oranžové podľa stavu, riadky produktov ostávajú neafarbené, konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
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
  await page.setViewportSize({ width: 1280, height: 900 });

  const pozadie = (selector: string): Promise<string | null> =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el === null ? null : getComputedStyle(el).backgroundColor;
    }, selector);
  const pozadieHlavicky = (dodavatel: string): Promise<string | null> =>
    page.evaluate((dod) => {
      const kontakt = document.querySelector(`[data-testid="supplier-contact-${dod}"]`);
      const hlavicka = kontakt?.closest(".toorder-supplier") ?? null;
      return hlavicka === null ? null : getComputedStyle(hlavicka).backgroundColor;
    }, dodavatel);

  // Počiatočný stav: "Všetci" je vybraný (predvolené) → oranžová, NIKDY
  // zeleno/červeno podľa súhrnného stavu ("nemá vlastný dátový stav").
  expect(await pozadie('[data-testid="supplier-chip-all"]'), "'Všetci' pri predvolenom výbere").toBe(
    "rgb(221, 164, 60)",
  );

  // DODAVATEL-TEST-1 (vybavené) → červená, na čipe AJ na hlavičke skupiny.
  expect(await pozadie('[data-testid="supplier-chip-DODAVATEL-TEST-1"]'), "čip DODAVATEL-TEST-1 (vybavené)").toBe(
    "rgb(209, 77, 59)",
  );
  expect(await pozadieHlavicky("DODAVATEL-TEST-1"), "hlavička DODAVATEL-TEST-1 (vybavené)").toBe("rgb(209, 77, 59)");

  // DODAVATEL-TEST-2 (nespracované) → zelená, na čipe AJ na hlavičke skupiny.
  expect(await pozadie('[data-testid="supplier-chip-DODAVATEL-TEST-2"]'), "čip DODAVATEL-TEST-2 (nespracované)").toBe(
    "rgb(108, 171, 104)",
  );
  expect(await pozadieHlavicky("DODAVATEL-TEST-2"), "hlavička DODAVATEL-TEST-2 (nespracované)").toBe(
    "rgb(108, 171, 104)",
  );

  // Výber DODAVATEL-TEST-2: jeho čip aj hlavička prejdú na oranžovú (aktívny
  // výber prebíja zelenú), "Všetci" prestane byť oranžové a vráti sa na
  // NEUTRÁLNU sivú (nikdy nedostane zelenú/červenú podľa súhrnu).
  await page.getByTestId("supplier-chip-DODAVATEL-TEST-2").click();
  await expect(page.getByTestId("supplier-chip-DODAVATEL-TEST-2")).toHaveClass(/active/);
  expect(await pozadie('[data-testid="supplier-chip-DODAVATEL-TEST-2"]'), "vybraný čip DODAVATEL-TEST-2").toBe(
    "rgb(221, 164, 60)",
  );
  expect(await pozadieHlavicky("DODAVATEL-TEST-2"), "vybraná hlavička DODAVATEL-TEST-2").toBe("rgb(221, 164, 60)");
  expect(await pozadie('[data-testid="supplier-chip-all"]'), "'Všetci' po výbere iného dodávateľa").toBe(
    "rgb(238, 241, 236)",
  );

  // Výber DODAVATEL-TEST-1 (vybavené, teda AJ "done" AJ "active" naraz) —
  // majiteľ výslovne: "oranžová prebíja červenú aj zelenú". Overuje SKUTOČNE
  // vykreslenú farbu (poradie CSS pravidiel), nie len prítomnosť oboch tried.
  await page.getByTestId("supplier-chip-DODAVATEL-TEST-1").click();
  expect(await pozadie('[data-testid="supplier-chip-DODAVATEL-TEST-1"]'), "vybraný 'vybavený' čip DODAVATEL-TEST-1").toBe(
    "rgb(221, 164, 60)",
  );
  expect(await pozadieHlavicky("DODAVATEL-TEST-1"), "vybraná 'vybavená' hlavička DODAVATEL-TEST-1").toBe(
    "rgb(221, 164, 60)",
  );

  // Riadky produktov (issue 259's odstránené farbenie) nesmú niesť ŽIADNU z
  // troch stavových farieb ako pozadie — len priehľadné/biele.
  const farbyRiadkov = await page.evaluate(() =>
    [...document.querySelectorAll("tr.order-row")].map((r) => getComputedStyle(r).backgroundColor),
  );
  for (const bg of farbyRiadkov) {
    expect(["rgb(209, 77, 59)", "rgb(108, 171, 104)", "rgb(221, 164, 60)"], `riadok má stavovú farbu: ${bg}`).not.toContain(
      bg,
    );
  }

  // Vrátiť výber na "Všetci" — rovnaký dôvod ako reset "skryť vybavené" vyššie.
  await page.getByTestId("supplier-chip-all").click();

  expect(chyby).toEqual([]);
});
