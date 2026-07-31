import { expect, test, type ConsoleMessage } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze

// #57: nové ľavé menu má "Na objednanie" ako záložku pod priečinkom Eshop,
// nie ako predvolenú (tá je "Sync zo Shoptetu") — `?tab=orders` ju vyberie
// priamo, bez potreby klikať cez sidebar v každom teste.

// Rovnaká a JEDINÁ povolená výnimka ako v login.spec.ts/catalog.spec.ts.
const jeOcakavane = (m: ConsoleMessage): boolean =>
  m.location().url.includes("/api/me") && m.text().includes("401");

// issue 61: VLASTNÝ izolovaný účet (`scripts/e2e-setup.ts`'s komentár k
// `E2E_FILTRE_EMAIL` vysvetľuje dôvod aj poradie). Tento test je ZÁMERNE
// PRVÝ v súbore — overuje PÔVODNÉ seedované dáta skôr, než ich testy nižšie
// (zmena stavu, pridanie stavu do nastavenia, odškrtnutie "objednané")
// zmutujú. `scripts/e2e-setup.ts`: DODAVATEL-TEST-1 má 1 riadok v stave
// "caka_sa" (vybavený — posunutý za predvolený "objednane"), "(bez
// dodávateľa)" má 1 riadok v predvolenom "objednane" (nevybavený).
const E2E_FILTRE_EMAIL = "e2e-filtre@forestshop.sk";

test("manažér filtruje podľa dodávateľa, vidí súhrn ostáva vybaviť a skryje vybavené riadky, ktoré ostanú skryté aj po obnovení stránky, konzola je čistá", async ({
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
  await page.getByLabel("E-mail").fill(E2E_FILTRE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // issue 62: fixtúra pridala DODAVATEL-TEST-2 (2 riadky, `scripts/
  // e2e-setup.ts`'s "60055/10" súčtový pár) — celkový počet aj globálny
  // súhrn nižšie preto počítajú so 4 riadkami, nie s pôvodnými 2. issue 63:
  // fixtúra pridala ĎALŠIE 2 riadky BEZ dodávateľa ("60035/L"/"60035/M",
  // `orders-supplier-assign.spec.ts`'s fixtúra) — "(bez dodávateľa)" má preto
  // 3, nie 1, "Všetci" 6, nie 4.
  await expect(page.getByTestId("supplier-chip-all")).toHaveText("Všetci (6)");
  await expect(page.getByTestId("supplier-chip-DODAVATEL-TEST-1")).toHaveText("DODAVATEL-TEST-1 (1)");
  await expect(page.getByTestId("supplier-chip-(bez dodávateľa)")).toHaveText("(bez dodávateľa) (3)");

  const summary = page.getByTestId("orders-summary");
  await expect(summary).toHaveText("Ostáva vybaviť 5 z 6 · Čaká sa 1");

  // Klik na chip DODAVATEL-TEST-1 zúži zoznam len na jeho skupinu.
  await page.getByTestId("supplier-chip-DODAVATEL-TEST-1").click();
  await expect(page.getByTestId("supplier-DODAVATEL-TEST-1")).toBeVisible();
  await expect(page.getByTestId("supplier-(bez dodávateľa)")).not.toBeVisible();
  await expect(summary).toHaveText("DODAVATEL-TEST-1: ostáva vybaviť 0 z 1 · Čaká sa 1");

  // Klik na "(bez dodávateľa)" prepne filter na druhého dodávateľa.
  await page.getByTestId("supplier-chip-(bez dodávateľa)").click();
  await expect(page.getByTestId("supplier-(bez dodávateľa)")).toBeVisible();
  await expect(page.getByTestId("supplier-DODAVATEL-TEST-1")).not.toBeVisible();
  await expect(summary).toHaveText("(bez dodávateľa): ostáva vybaviť 3 z 3");

  // Späť na "Všetci" — obe skupiny opäť viditeľné.
  await page.getByTestId("supplier-chip-all").click();
  await expect(page.getByTestId("supplier-DODAVATEL-TEST-1")).toBeVisible();
  await expect(page.getByTestId("supplier-(bez dodávateľa)")).toBeVisible();

  // Skryť vybavené riadky — DODAVATEL-TEST-1 (celý vybavený, "caka_sa") zmizne,
  // "(bez dodávateľa)" (má nevybavený riadok) ostáva viditeľný.
  const toggle = page.getByTestId("orders-hide-resolved-toggle");
  await expect(toggle).toHaveText("👁 Skryť vybavené");
  await toggle.click();
  await expect(page.getByTestId("supplier-DODAVATEL-TEST-1")).not.toBeVisible();
  await expect(page.getByTestId("supplier-(bez dodávateľa)")).toBeVisible();

  // Prepínač prežije obnovenie stránky (localStorage, issue 61's hlavná požiadavka).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  await expect(page.getByTestId("orders-hide-resolved-toggle")).toHaveText("🙈 Vybavené skryté");
  await expect(page.getByTestId("supplier-DODAVATEL-TEST-1")).not.toBeVisible();

  // Vypnutie prepínača vráti skrytú skupinu späť.
  await page.getByTestId("orders-hide-resolved-toggle").click();
  await expect(page.getByTestId("supplier-DODAVATEL-TEST-1")).toBeVisible();

  // issue 95: stránka sa NIKDY nesmie posúvať vodorovne, na žiadnej zo
  // štyroch testovaných šírok — keď je tabuľka širšia než dostupné miesto,
  // posúva sa len jej VLASTNÝ obal (`.orders-table-wrap`), nikdy
  // `document.body`. Rovnaký účet z tohto testu ostáva prihlásený, žiadne
  // ďalšie prihlásenie netreba (šetrí `MAX_ATTEMPTS` rozpočet —
  // `.claude/rules/frontend-design.md`).
  //
  // issue 105 bod 1: naživo namerané pretekanie hlavičiek stĺpcov
  // (`th.scrollWidth > th.clientWidth`, napr. "OBJEDNANÉ"/"OBJEDNÁVKA" sa pri
  // 1280px zlievali so susednou hlavičkou) sa unit testom (JSDOM nerenderuje
  // skutočné šírky) ani doterajším 3-šírkovým behom (chýbalo 1440px)
  // nezachytilo — teraz sa kontroluje KAŽDÁ `<th>` na VŠETKÝCH štyroch
  // šírkach, ktoré ticket predpisuje.
  for (const width of [1280, 1440, 1600, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const { bodyWidth, viewportWidth, pretekajuceHlavicky } = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      pretekajuceHlavicky: [...document.querySelectorAll<HTMLTableCellElement>(".orders-table th")]
        .filter((th) => th.scrollWidth > th.clientWidth)
        .map((th) => `"${th.textContent}" (${String(th.scrollWidth)}px text vs ${String(th.clientWidth)}px bunka)`),
    }));
    expect(bodyWidth, `šírka okna ${String(width)}px`).toBeLessThanOrEqual(viewportWidth);
    expect(pretekajuceHlavicky, `pretekajúce hlavičky pri ${String(width)}px`).toEqual([]);
  }

  // Priblíženie prehliadača (majiteľ: "ked aj scalujem tak sa ten stred
  // nescaluje") — CSS `zoom` je Chromium's náprotivok Ctrl+/- priblíženia,
  // `documentElement.clientWidth` sa pod ním prepočíta rovnako ako reálny
  // prehliadačový zoom.
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1.25";
  });
  const poZoome = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(poZoome.bodyWidth).toBeLessThanOrEqual(poZoome.clientWidth);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });

  expect(chyby).toEqual([]);
});

// issue 62: VLASTNÝ izolovaný účet (balík je už na hranici MAX_ATTEMPTS=10,
// `scripts/e2e-setup.ts`'s komentár k `E2E_SUCET_EMAIL`).
const E2E_SUCET_EMAIL = "e2e-sucet@forestshop.sk";

// issue 62: `scripts/e2e-setup.ts` zakladá DVE objednávky (9004 + 9005) od
// dvoch rôznych zákazníkov nad TÝM ISTÝM variantom "60055/10" (3 ks + 2 ks,
// obe vo východiskovom nevybavenom stave) pod novým dodávateľom
// "DODAVATEL-TEST-2" — presne scenár, ktorý tento ticket rieši: chip
// "Σ spolu" na OBOCH riadkoch ukazuje 5 ks (celé dopytované množstvo je
// zároveň celé nevybavené) a po odškrtnutí JEDNÉHO riadku ako objednaného sa
// ihneď (bez reloadu) prepočíta na 2 ks na OBOCH riadkoch naraz.
test("súčet kusov toho istého produktu naprieč objednávkami dodávateľa sa prepočíta hneď po zmene stavu riadku, konzola je čistá", async ({
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
  await page.getByLabel("E-mail").fill(E2E_SUCET_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  const skupina = page.getByTestId("supplier-DODAVATEL-TEST-2");
  await expect(skupina).toBeVisible();

  const riadokPrva = skupina.locator("[data-testid^='order-line-']").filter({ hasText: "E2E Zákazník Súčet Prvá" });
  const riadokDruha = skupina.locator("[data-testid^='order-line-']").filter({ hasText: "E2E Zákazník Súčet Druhá" });
  const chipPrva = riadokPrva.locator("[data-testid^='qty-total-']");
  const chipDruha = riadokDruha.locator("[data-testid^='qty-total-']");

  // Pred akoukoľvek zmenou: obe objednávky nevybavené → chip na OBOCH
  // riadkoch ukazuje celé dopytované množstvo (3 + 2 = 5) ako zostávajúce.
  await expect(chipPrva).toHaveText("Σ spolu 5 ks");
  await expect(chipPrva).toHaveAttribute("title", "Spolu vo všetkých objednávkach: 5 ks · nevybavené: 5 ks");
  await expect(chipDruha).toHaveText("Σ spolu 5 ks");

  // Odškrtnutie PRVÉHO riadku (3 ks) ako objednané — `.click()`, nie
  // `.check()` (`.claude/rules/testing.md`: zápis je async, `.check()` by na
  // pomalšom CI behu prehral závod so serverovou odpoveďou).
  const checkboxPrva = riadokPrva.locator("input[type='checkbox']");
  await checkboxPrva.click();
  await expect(checkboxPrva).toBeChecked();

  // Prepočet je OKAMŽITÝ (bez `page.reload()`) a týka sa OBOCH riadkov
  // naraz — presne požiadavka ticketu ("súčet sa musí prepočítať hneď po
  // zmene stavu riadku, bez obnovenia stránky").
  await expect(chipPrva).toHaveText("Σ spolu 2 ks");
  await expect(chipDruha).toHaveText("Σ spolu 2 ks");
  await expect(chipDruha).toHaveAttribute("title", "Spolu vo všetkých objednávkach: 5 ks · nevybavené: 2 ks");
  await expect(page.getByRole("alert")).toHaveCount(0);

  expect(chyby).toEqual([]);
});

test("manažér vidí otvorené objednávky zoskupené podľa dodávateľa, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // `scripts/e2e-setup.ts` zakladá objednávku 9001 nad variantom "4859/46",
  // ktorý má v exporte skutočného dodávateľa "DODAVATEL-TEST-1".
  const skupinaDodavatel = page.getByTestId("supplier-DODAVATEL-TEST-1");
  await expect(skupinaDodavatel).toBeVisible();
  const riadokAlfa = skupinaDodavatel.locator("[data-testid^='order-line-']");
  await expect(riadokAlfa).toContainText("9001");
  await expect(riadokAlfa).toContainText("E2E Zákazník Alfa");
  await expect(riadokAlfa).toContainText("4859/46");
  await expect(riadokAlfa).toContainText("Nohavice Hart Wild-T");
  await expect(riadokAlfa).toContainText("46");
  await expect(riadokAlfa).toContainText("2");
  await expect(riadokAlfa).toContainText("Čaká sa");
  // issue 64: poznámka k objednávke je pre `canChangeState` role (tento účet
  // je "manazer") editovateľný `<input>`, nie prostý text — `toContainText`
  // číta `textContent`, ktorý hodnotu `<input>` NEOBSAHUJE. Skutočnú hodnotu
  // preto overuje `toHaveValue` na samotnom vstupe (rovnaký dôvod ako
  // `.claude/rules/testing.md`'s poznámka o jest-dom matcheroch — tu ide o
  // Playwright, nie vitest, ale princíp "vstup nie je text" je ten istý).
  await expect(riadokAlfa.getByLabel("Poznámka k objednávke 9001 / 4859/46")).toHaveValue("Zavolať pred doručením");

  // issue 67: fixtúra ("4859/46") má reálny holý odkaz na dodávateľa
  // (`internalNote`) aj kód dodávateľa (`externalCode`, "OB832") —
  // over cez map-row.test.ts, ak sa fixtúra niekedy zmení.
  const odkazAlfa = riadokAlfa.getByRole("link", { name: "Odkaz na dodávateľa" });
  await expect(odkazAlfa).toHaveAttribute("href", "https://www.huntingshop.eu/wild-t-green-nohavice");
  await expect(riadokAlfa).toContainText("OB832");

  // issue 65: zákaznícky odkaz (`remark`, read-only) + priamy odkaz do
  // Shoptet administrácie (`adminUrl`) — objednávka 9001.
  // issue 99: klikateľné je samotné ČÍSLO objednávky (nie samostatná ikonka
  // `🔗` vedľa neho, ktorá predtým niesla ten istý odkaz) — over href/target/
  // rel AJ to, že viditeľný text odkazu je presne číslo objednávky a žiadna
  // ikonka nezostala.
  await expect(riadokAlfa).toContainText("Prosím doručiť len v piatok");
  const adminOdkazAlfa = riadokAlfa.getByRole("link", { name: "Otvoriť objednávku 9001 v administrácii Shoptet" });
  await expect(adminOdkazAlfa).toHaveAttribute(
    "href",
    "https://www.forestshop.sk/admin/vyhladavanie/?string=9001&src=orders",
  );
  await expect(adminOdkazAlfa).toHaveAttribute("target", "_blank");
  await expect(adminOdkazAlfa).toHaveText("9001");
  await expect(riadokAlfa.getByRole("link", { name: "Otvoriť objednávku" })).toHaveCount(1);
  await expect(riadokAlfa).not.toContainText("🔗");
  // Objednávka 9001 je UŽ vybavená (stav "caka_sa") — upozornenie na staré
  // objednávky sa NIKDY nezobrazí pre vybavený riadok, aj keby bol starý.
  await expect(riadokAlfa.locator("[data-testid^='stale-badge-']")).toHaveCount(0);

  // Objednávka 9002 je nad variantom "40287", ktorý nemá dodávateľa
  // (`product.supplier` je `null`) — zoskupí sa pod zástupný kľúč, nie pod
  // "null" a nezmizne.
  const skupinaBezDodavatela = page.getByTestId("supplier-(bez dodávateľa)");
  await expect(skupinaBezDodavatela).toBeVisible();
  // issue 63: fixtúra pridala ĎALŠIE 2 riadky BEZ dodávateľa (objednávka
  // 9006) — skupina má teraz 3 riadky, `.filter({ hasText })` zúži presne na
  // riadok objednávky 9002 (inak by `[data-testid^='order-line-']` zhodou
  // troch prvkov spadlo na strict-mode violation).
  const riadokBez = skupinaBezDodavatela.locator("[data-testid^='order-line-']").filter({ hasText: "9002" });
  await expect(riadokBez).toContainText("9002");
  await expect(riadokBez).toContainText("E2E Zákazník Bez dodávateľa");
  await expect(riadokBez).toContainText("40287");
  await expect(riadokBez).toContainText("Čiapka Polar FOREST");
  // Predvolený stav riadku (schema default "objednane") a chýbajúca veľkosť —
  // issue 60: premenované na "Nevybavené" (slovo "Objednané" teraz patrí
  // výlučne novému odškrtávaciemu políčku).
  await expect(riadokBez).toContainText("Nevybavené");

  // issue 65: objednávka 9002 zámerne nesie placedAt hlboko v minulosti
  // (`scripts/e2e-setup.ts`) a zostáva NEVYBAVENÁ (predvolený stav) — presne
  // ten prípad, ktorý má dostať upozornenie ⚠️ na starú objednávku.
  const staleBadgeBez = riadokBez.locator("[data-testid^='stale-badge-']");
  await expect(staleBadgeBez).toBeVisible();
  await expect(staleBadgeBez).toContainText("⚠️");
  await expect(staleBadgeBez).toContainText("dní");

  expect(chyby).toEqual([]);
});

// #25: manažér prepne stav riadku cez select v UI a zmena PRETRVÁ po obnovení
// stránky. Zápis stavu a audit bežia v JEDNEJ transakcii (`modules/orders/
// state.ts`) — pretrvanie po reloade je teda dôkazom, že transakcia skutočne
// commitla (audit zápis neyhodil výnimku, ktorá by ju bola vrátila späť).
// Samotný obsah auditového riadku (kto, kedy, z akého stavu do akého) overuje
// integračný test (`apps/api/tests/orders-http.integration.test.ts`) priamo
// nad databázou — tam patrí kontrola stĺpcov DB riadku, nie do e2e.
test("manažér prepne stav riadku cez select, zmena pretrvá po obnovení stránky, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // Objednávka 9001 (dodávateľ "DODAVATEL-TEST-1") má riadok so stavom
  // "caka_sa" (`scripts/e2e-setup.ts`).
  const riadok = page.getByTestId("supplier-DODAVATEL-TEST-1").locator("[data-testid^='order-line-']");
  const select = riadok.locator("select");
  await expect(select).toHaveValue("caka_sa");

  await select.selectOption("skladom");
  // Nie `toContainText("Skladom")` — VŠETKY štyri `STATE_LABELS` sú vždy
  // vykreslené ako `<option>` deti selectu bez ohľadu na to, ktorý je
  // vybraný, takže taká kontrola textu je tautológia (vždy prejde, aj keď sa
  // zápis nikdy nedokončí). `toHaveValue` na SAMOTNOM selecte skutočne čaká,
  // kým lokálny optimistický update prebehne (deje sa AŽ po úspešnom
  // vyriešení PATCH promisu, `OrdersSection.tsx`'s `changeState`), čím
  // zaručuje, že zápis je na serveri potvrdený PRED nasledujúcim reloadom —
  // bez tejto zmeny mohol pod pomalším CI behom `page.reload()` predbehnúť
  // ešte neuzavretý zápis a nasledujúca kontrola po reloade náhodne zlyhala.
  await expect(select).toHaveValue("skladom");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  const riadokPoReloade = page.getByTestId("supplier-DODAVATEL-TEST-1").locator("[data-testid^='order-line-']");
  await expect(riadokPoReloade.locator("select")).toHaveValue("skladom");

  expect(chyby).toEqual([]);
});

// #31: e-mailový kontakt dodávateľa + náhľad objednávky mailom, cez skutočný
// prehliadač nad reálne naimportovanými fixtúrovými dátami (`scripts/
// e2e-setup.ts`). Skutočné ODOSLANIE (SMTP) sa tu zámerne NEKLIKÁ — MAIL_HOST
// nie je v e2e prostredí nakonfigurovaný (`playwright.config.ts`), takže
// server by na "Odoslať" vrátil 503, čo by (rovnako ako akýkoľvek iný
// 4xx/5xx fetch) zalogovalo console error a porušilo jedinú povolenú
// výnimku (`.claude/rules/testing.md`) — samotné odoslanie je overené
// integračne (`apps/api/tests/supplier-mail.integration.test.ts`) s falošným
// transportom. E2E overuje SKUTOČNÝ prehliadačový workflow: nastavenie
// e-mailu (perzistuje po reloade) a náhľad so správne agregovaným obsahom.
test("manažér nastaví e-mail dodávateľa a uvidí náhľad mailu so správne agregovaným obsahom, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill("e2e@forestshop.sk");
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // Objednávka 9001 (dodávateľ "DODAVATEL-TEST-1") má JEDINÝ riadok vo stave
  // "caka_sa" (`scripts/e2e-setup.ts`) — teda ŽIADNU otvorenú položku na
  // objednanie. Tlačidlo odoslania preto musí byť disabled, aj keď sa
  // e-mail dodávateľa nastaví — overuje, že disabled stav sleduje SKUTOČNÝ
  // stav riadkov, nie len prítomnosť e-mailu.
  const skupinaTest1 = page.getByTestId("supplier-DODAVATEL-TEST-1");
  await skupinaTest1.getByRole("button", { name: "Upraviť e-mail" }).click();
  await skupinaTest1.getByLabel("E-mail dodávateľa DODAVATEL-TEST-1").fill("test1@dodavatel.example");
  // issue 64: `{ exact: true }` — skupina teraz obsahuje AJ tlačidlo na
  // uloženie poznámky k objednávke ("💾", aria-label "Uložiť poznámku k
  // objednávke…"), ktorého accessible name OBSAHUJE "Uložiť" ako substring
  // (rovnaký zistený vzor ako issue 63 nižšie, `.claude/rules/http-routes.md`
  // susedný komentár vysvetľuje princíp: oprava patrí na stranu TOHTO
  // (existujúceho, užšieho) locatora).
  await skupinaTest1.getByRole("button", { name: "Uložiť", exact: true }).click();
  await expect(skupinaTest1.getByText("E-mail dodávateľa: test1@dodavatel.example")).toBeVisible();
  await expect(skupinaTest1.getByRole("button", { name: "✉️ Poslať objednávku e-mailom" })).toBeDisabled();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  await expect(
    page.getByTestId("supplier-DODAVATEL-TEST-1").getByText("E-mail dodávateľa: test1@dodavatel.example"),
  ).toBeVisible();

  // Objednávka 9002 (zástupný dodávateľ "(bez dodávateľa)") má riadok vo
  // východiskovom stave "objednane" — TÁ skupina má odoslanie povolené,
  // hneď ako dostane e-mail.
  const skupinaBezDodavatela = page.getByTestId("supplier-(bez dodávateľa)");
  await skupinaBezDodavatela.getByRole("button", { name: "Upraviť e-mail" }).click();
  await skupinaBezDodavatela.getByLabel("E-mail dodávateľa (bez dodávateľa)").fill("nezaradene@example.com");
  // issue 63: `{ exact: true }` — skupina teraz obsahuje AJ priraďovacie
  // tlačidlá "💾" (aria-label "Uložiť priradenie dodávateľa…"), ktorých
  // accessible name OBSAHUJE "Uložiť" ako substring (Playwright's substring
  // zhoda bez `exact`, `.claude/rules/pairing.md`'s zistený vzor). Oprava je
  // na strane TOHTO (existujúceho, užšieho) locatora, nie oberaním nového
  // tlačidla o jeho plnohodnotný popis.
  await skupinaBezDodavatela.getByRole("button", { name: "Uložiť", exact: true }).click();
  const poslatTlacidlo = skupinaBezDodavatela.getByRole("button", { name: "✉️ Poslať objednávku e-mailom" });
  await expect(poslatTlacidlo).toBeEnabled();
  await poslatTlacidlo.click();

  const nahlad = skupinaBezDodavatela.getByTestId("mail-preview-(bez dodávateľa)");
  await expect(nahlad).toBeVisible();
  await expect(nahlad).toContainText("nezaradene@example.com");
  // "40287" je jednovariantný produkt (žiadna veľkosť) s množstvom 1
  // (`scripts/e2e-setup.ts`). issue 63: fixtúra pridala ĎALŠIE 2 riadky BEZ
  // dodávateľa v predvolenom stave "objednane" ("60035/L"/"60035/M", obe
  // veľkosti odvodené priamo z kódu, `map-row.ts`'s `splitCode`) — mailová
  // agregácia preto teraz vidí 3 položky, nie 1, zoradené vzostupne podľa
  // kódu variantu.
  await expect(nahlad).toContainText("Objednávka — (bez dodávateľa) (3 položky)");
  await expect(nahlad.locator("pre")).toHaveText(
    "Objednávka — (bez dodávateľa) (3 položky)\n40287 | 1 ks\n60035/L | L | 1 ks\n60035/M | M | 1 ks",
  );

  // Zrušenie náhľadu — v tomto teste sa zámerne NEODOSIELA (viď komentár
  // vyššie).
  await nahlad.getByRole("button", { name: "Zrušiť" }).click();
  await expect(nahlad).not.toBeVisible();

  expect(chyby).toEqual([]);
});

// issue 59: VLASTNÝ izolovaný účet (nie zdieľaný `e2e@forestshop.sk`) —
// balík je už na hranici `MAX_ATTEMPTS=10` (viď `scripts/e2e-setup.ts`'s
// komentár k `E2E_NAV_EMAIL`), ďalšie prihlásenie pod zdieľaným účtom by ho
// prekročilo.
const E2E_OTVORENE_STAVY_EMAIL = "e2e-otvorene-stavy@forestshop.sk";

// `scripts/e2e-setup.ts` zakladá TRETIU objednávku (9003, zákazník "E2E
// Zákazník Uzavretá") so stavom "E2E-Uzavreta" — zámerne MIMO predvoleného
// otvoreného zoznamu ("Vybavuje sa"). Test dokazuje OBE polovice ticketu
// naraz: (a) uzavretá objednávka sa v "Na objednanie" vôbec neukáže, (b) po
// pridaní jej stavu cez nastavenie priamo v UI sa objaví bez reloadu —
// presne "zoznam reaguje na zmenu nastavenia".
test("uzavretá objednávka sa v 'Na objednanie' neukáže, kým sa jej stav nepridá do nastavenia, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill(E2E_OTVORENE_STAVY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  const skupinaBezDodavatela = page.getByTestId("supplier-(bez dodávateľa)");
  await expect(skupinaBezDodavatela).toBeVisible();
  await expect(skupinaBezDodavatela).not.toContainText("E2E Zákazník Uzavretá");

  const panel = page.getByTestId("order-open-statuses-panel");
  await panel.getByRole("button", { name: "⚙️ Nastavenie stavov objednávok" }).click();
  const textarea = panel.getByTestId("order-open-statuses-textarea");
  await expect(textarea).toHaveValue("Vybavuje sa");

  // Pridáva sa (nikdy nenahrádza) k existujúcemu zoznamu — 9001/9002 (stav
  // "Vybavuje sa") musia zostať viditeľné aj po uložení.
  await textarea.fill("Vybavuje sa\nE2E-Uzavreta");
  await panel.getByRole("button", { name: "💾 Uložiť" }).click();
  await expect(panel.getByRole("status")).toContainText("Uložené");

  await expect(skupinaBezDodavatela).toContainText("E2E Zákazník Uzavretá");
  // Pôvodné objednávky (default stav) ostávajú viditeľné — pridanie stavu do
  // zoznamu nikdy neodstráni iný, už nastavený stav.
  await expect(skupinaBezDodavatela).toContainText("E2E Zákazník Bez dodávateľa");
  const skupinaTest1 = page.getByTestId("supplier-DODAVATEL-TEST-1");
  await expect(skupinaTest1).toContainText("9001");

  expect(chyby).toEqual([]);
});

// issue 60: VLASTNÝ izolovaný účet — balík je už na hranici MAX_ATTEMPTS=10
// (viď `scripts/e2e-setup.ts`'s komentár k `E2E_OBJEDNANE_EMAIL`).
const E2E_OBJEDNANE_EMAIL = "e2e-objednane@forestshop.sk";

// issue 60: odškrtávacie políčko "objednané u dodávateľa" (per riadok) a
// hromadné označenie/zrušenie CELEJ skupiny naraz. Používa skupinu
// "DODAVATEL-TEST-1" (objednávka 9001, JEDINÝ riadok) — nie
// "(bez dodávateľa)", ktorú iný test v tomto súbore (uzavretá objednávka
// vyššie) môže medzičasom rozšíriť o druhý riadok; DODAVATEL-TEST-1 má vždy
// presne jeden riadok bez ohľadu na poradie behu ostatných testov v súbore.
test("manažér odškrtne riadok ako objednaný a hromadne označí/zruší celú skupinu, konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !jeOcakavane(m)) chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill(E2E_OBJEDNANE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  const skupina = page.getByTestId("supplier-DODAVATEL-TEST-1");
  const riadok = skupina.locator("[data-testid^='order-line-']");
  const checkbox = riadok.locator("input[type='checkbox']");
  await expect(checkbox).not.toBeChecked();
  await expect(riadok).not.toHaveClass(/ordered/);

  // Per riadok — odškrtnutie stlmí CELÝ riadok a pretrvá po obnovení stránky.
  // `.click()`, NIE `.check()` — `.check()` si sám ihneď po kliku overí stav,
  // no zápis je async (POST na server), takže by na pomalšom CI behu zlyhal
  // presne rovnakým dôvodom ako `<select>` v teste vyššie
  // (`.claude/rules/testing.md`): `expect(...).toBeChecked()` nižšie SKUTOČNE
  // čaká (opakovane skúša), kým sa lokálny optimistický update po vyriešení
  // promisu prejaví.
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(riadok).toHaveClass(/ordered/);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  const riadokPoReloade = page.getByTestId("supplier-DODAVATEL-TEST-1").locator("[data-testid^='order-line-']");
  await expect(riadokPoReloade.locator("input[type='checkbox']")).toBeChecked();

  // Hromadné tlačidlo — skupina je UŽ celá objednaná, tlačidlo preto ponúka
  // ZRUŠENIE (opačný smer), nie opätovné označenie.
  const zrusitTlacidlo = skupina.getByRole("button", { name: "↺ Zrušiť označenie skupiny" });
  await expect(zrusitTlacidlo).toBeVisible();
  await zrusitTlacidlo.click();
  await expect(riadokPoReloade.locator("input[type='checkbox']")).not.toBeChecked();
  await expect(riadokPoReloade).not.toHaveClass(/ordered/);

  // Tlačidlo sa prepne späť na "označiť" a hromadné označenie funguje aj
  // opačným smerom.
  const oznacitTlacidlo = skupina.getByRole("button", { name: "✔ Označiť skupinu ako objednané" });
  await oznacitTlacidlo.click();
  await expect(riadokPoReloade.locator("input[type='checkbox']")).toBeChecked();

  expect(chyby).toEqual([]);
});

// issue 64: rovnaký mechanizmus a dôvod ako `E2E_PRIRADENIE_EMAIL`/
// `E2E_OBJEDNANE_EMAIL` vyššie — balík je UŽ na hranici `MAX_ATTEMPTS`
// (komentár pri `E2E_NAV_EMAIL` v `scripts/e2e-setup.ts`).
const E2E_KOMENTAR_EMAIL = "e2e-komentar@forestshop.sk";

// issue 64: manažérova voľná poznámka k CELEJ objednávke. Používa objednávku 9001
// (skupina "DODAVATEL-TEST-1", JEDINÝ riadok, seedovaná s poznámkou "Zavolať
// pred doručením") — test EDITUJE túto zdieľanú poznámku, ale nepridáva ani
// nepresúva žiadny riadok (na rozdiel od testu priradenia nižšie), takže
// nemení počty, na ktoré sa spolieha test odškrtávania vyššie ("skupina má
// vždy presne 1 riadok"). Poznámka sa na konci VRÁTI na pôvodnú hodnotu —
// hygiena zdieľaných dát pre prípadné ďalšie testy pridané neskôr v tomto
// súbore (rovnaká disciplína ako restore-at-end kdekoľvek inde v projekte).
test("manažér napíše a upraví poznámku k objednávke, zmena pretrvá po obnovení stránky, konzola je čistá", async ({
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
  await page.getByLabel("E-mail").fill(E2E_KOMENTAR_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  const vstup = page.getByLabel("Poznámka k objednávke 9001 / 4859/46");
  await expect(vstup).toHaveValue("Zavolať pred doručením");

  await vstup.fill("Vyzdvihnúť v sklade do piatku");
  await page.getByLabel("Uložiť poznámku k objednávke 9001 / 4859/46").click();
  // `toHaveValue` skutočne čaká (opakovane skúša), kým lokálny optimistický
  // update po vyriešení PUT promisu prejaví — rovnaký dôvod ako `<select>`
  // v teste stavu vyššie (`.claude/rules/testing.md`).
  await expect(vstup).toHaveValue("Vyzdvihnúť v sklade do piatku");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  const vstupPoReloade = page.getByLabel("Poznámka k objednávke 9001 / 4859/46");
  await expect(vstupPoReloade).toHaveValue("Vyzdvihnúť v sklade do piatku");

  // Vrátenie na pôvodnú hodnotu (hygiena zdieľaných fixtúrových dát).
  await vstupPoReloade.fill("Zavolať pred doručením");
  await page.getByLabel("Uložiť poznámku k objednávke 9001 / 4859/46").click();
  await expect(vstupPoReloade).toHaveValue("Zavolať pred doručením");

  expect(chyby).toEqual([]);
});

// issue 63: VLASTNÝ izolovaný účet — balík je už na hranici `MAX_ATTEMPTS`
// (komentár vyššie pri `E2E_NAV_EMAIL`). Test je ZÁMERNE POSLEDNÝ v súbore —
// priradenie MENÍ SKUPINU (presúva riadok preč z "(bez dodávateľa)"), takže
// žiadny INÝ test v tomto súbore nesmie bežať PO ňom, ak sa spolieha na
// pôvodný (nezmenený) obsah "(bez dodávateľa)" (rovnaký dôvod ako testy
// vyššie, ktoré sú tiež zámerne umiestnené podľa toho, čo mutujú).
const E2E_PRIRADENIE_EMAIL = "e2e-priradenie@forestshop.sk";

test("manažér ručne priradí dodávateľa riadku bez dodávateľa s našepkávaním, priradenie platí aj pre ĎALŠIU veľkosť toho istého produktu, konzola je čistá", async ({
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
  await page.getByLabel("E-mail").fill(E2E_PRIRADENIE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // Riadok BEZ dodávateľa (objednávka 9006, `scripts/e2e-setup.ts`) — pole na
  // priradenie je viditeľné a prázdne (kým riadok DODAVATEL-TEST-1 s
  // katalógovým dodávateľom nemá blok priradenia VÔBEC — issue 107 bod 3
  // odstránilo predtým holú pomlčku, blok sa dnes nevykreslí vôbec, nie len
  // zobrazí "—").
  const vstupL = page.getByLabel("Priradiť dodávateľa riadku objednávky 9006 / 60035/L");
  await expect(vstupL).toBeVisible();
  await expect(vstupL).toHaveValue("");
  const bunkaTest1 = page
    .getByTestId("supplier-DODAVATEL-TEST-1")
    .locator("[data-testid^='supplier-assign-cell-']");
  await expect(bunkaTest1).toHaveCount(0);

  // Našepkávanie: known-suppliers datalist musí ponúkať UŽ existujúceho
  // dodávateľa (dôkaz, že sa berie zo skutočne načítaných skupín, nie z
  // pevného zoznamu) — nie holý ASCII-art, priamy DOM dôkaz.
  await expect(page.locator("#known-suppliers option[value='DODAVATEL-TEST-1']")).toHaveCount(1);

  await vstupL.fill("E2E Dodávateľ Priradenie");
  await page.getByLabel("Uložiť priradenie dodávateľa riadku objednávky 9006 / 60035/L").click();

  // Refetch po uložení (`OrdersSection.tsx`'s `assignSupplier`) — nová
  // skupina sa objaví, riadok "60035/L" je v nej.
  const novaSkupina = page.getByTestId("supplier-E2E Dodávateľ Priradenie");
  await expect(novaSkupina).toBeVisible();
  await expect(novaSkupina).toContainText("60035/L");

  // issue 63 bod 2: priradenie cez JEDNU veľkosť platí aj pre "60035/M" —
  // TEN ISTÝ produkt, iný riadok, nikdy ručne priradený, a napriek tomu je v
  // TEJ ISTEJ novej skupine (produktová perzistencia, `product_supplier_
  // override`).
  await expect(novaSkupina).toContainText("60035/M");
  const vstupM = page.getByLabel("Priradiť dodávateľa riadku objednávky 9006 / 60035/M");
  await expect(vstupM).toHaveValue("E2E Dodávateľ Priradenie");

  // Pretrvanie po obnovení stránky — priradenie je v DB (`product_supplier_
  // override`), nielen v optimistickom klientskom stave.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  const novaSkupinaPoReloade = page.getByTestId("supplier-E2E Dodávateľ Priradenie");
  await expect(novaSkupinaPoReloade).toContainText("60035/L");
  await expect(novaSkupinaPoReloade).toContainText("60035/M");

  expect(chyby).toEqual([]);
});
