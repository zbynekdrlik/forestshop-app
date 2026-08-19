import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// Vlastný, IZOLOVANÝ účet len pre tento súbor (rovnaký dôvod aj mechanizmus
// ako `E2E_SKUPINY_EMAIL` v `pairing.spec.ts`/`scripts/e2e-setup.ts`): zdieľaný
// `e2e@forestshop.sk` mal už PRESNE 10 prihlásení naprieč zvyškom balíka
// (catalog 3 + login 2 + orders 3 + pairing 2), presne na hranici
// `MAX_ATTEMPTS` (`login-rate-limit.ts`) — pridanie ĎALŠÍCH 2 prihlásení sem by
// ju prekročilo a spôsobilo náhodné "Nesprávny e-mail alebo heslo" na inom
// teste v tom istom behu. Musí sa zhodovať s `E2E_NAV_EMAIL` v
// `scripts/e2e-setup.ts`.
const E2E_NAV_EMAIL = "e2e-nav@forestshop.sk";

// #57 pôvodne chcel naľavo PRESNE dve položky. Issue 185 (2026-08-03) pridáva
// tretí priečinok "Automatizácie" s tromi hotovými obrazovkami, dovtedy len v
// `HIDDEN_TABS` bez odkazu v menu. Issue 239 (2026-08-04) pridáva "Párovanie
// produktov" pod "Eshop" — desiata záložka. Issue 240 (2026-08-05) pridáva
// "Vyhľadať" pod "Eshop" — jedenásta záložka. Issue 257 (2026-08-05) pridáva
// "Zlúčenie objednávok" pod "Eshop" — dvanásta záložka (funkčný test v
// samostatnom `order-merge.spec.ts`, rovnaký vzor ako "Vyhľadať"/
// `search.spec.ts`). Issue 267 (2026-08-05) pridáva "Upozornenia" pod
// "Eshop" — trinásta záložka (funkčný test v samostatnom
// `upozornenia.spec.ts`, rovnaký vzor). Issue 290 (2026-08-07) pridáva TRI
// ďalšie záložky HNEĎ POD "Nedostupné tovary" — "Výmena tovaru"/"Vrátený
// tovar"/"Reklamácie" — šestnásta záložka celkovo (funkčný test v
// samostatnom `order-flags.spec.ts`, rovnaký vzor). Issue 311 (2026-08-07)
// pridalo "Vypredané → Skladom: návrhy odkazov" HNEĎ ZA "Vypredané →
// Skladom" — issue 387 E8 (2026-08-13) ju ODSTRÁNILO (nahradená obrazovkou
// "Párovanie", pozri nižšie), takže sa do celkového počtu už nepočíta. Issue
// 400 (issue 387 E9, 2026-08-13) odstránilo aj samotnú "Párovanie produktov"
// (#239, majiteľ ju výslovne schválil na odstránenie) — takže sa do
// celkového počtu záložiek už tiež nepočíta.
// Issue 292 (2026-08-08) pridáva "Preprava DPD" NA KONIEC priečinka "Eshop"
// (funkčný test v samostatnom `dpd.spec.ts`, rovnaký vzor). Issue 342
// (2026-08-11) pridáva ŠTVRTÝ priečinok "Dôležité" (PRED "Eshop" — hlavný
// login screen odteraz vidí menu v poradí Dôležité/Eshop/Systém/
// Automatizácie), presúva "Upozornenia" doňho (z priečinka "Eshop") a pridáva
// novú záložku "Úlohy na dnes" (funkčný test v samostatnom
// `daily-tasks.spec.ts`, rovnaký vzor). Issue 345 (2026-08-11) pridalo
// "Objednávky predajňa" HNEĎ ZA "Na objednanie" — issue 410 (2026-08-13)
// nahradilo jej Shoptet-viazaný obsah vlastnými zápismi z predajne
// (`id`/`label`/miesto v menu nezmenené, funkčný test teraz v samostatnom
// `floor-notes.spec.ts`, rovnaký vzor).
test("ľavé menu má štyri priečinky (Dôležité/Eshop/Systém/Automatizácie) s dvadsiatimi záložkami, klik prepne obrazovku, panel sa zbalí do lišty a stav si pamätá, konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_NAV_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // Presne štyri priečinky.
  await expect(page.getByRole("button", { name: "Dôležité" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Systém" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Eshop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Automatizácie" })).toBeVisible();

  // issue 343: "Systém" a "Automatizácie" štartujú ZBALENÉ (menu by inak
  // presahovalo výšku obrazovky), "Eshop" ostáva rozbalený — over predvolený
  // stav priamo po prihlásení, potom oba priečinky rozbaľ, aby zvyšok tohto
  // testu mohol pokračovať v pôvodnom toku a klikať na ich záložky. Issue 342:
  // "Dôležité" štartuje ROZBALENÝ (dennodenne používaná obrazovka, rovnaký
  // dôvod ako "Eshop").
  await expect(page.getByRole("button", { name: "Dôležité" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Eshop" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Systém" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Automatizácie" })).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Systém" }).click();
  await page.getByRole("button", { name: "Automatizácie" }).click();
  await expect(page.getByRole("button", { name: "Systém" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Automatizácie" })).toHaveAttribute("aria-expanded", "true");

  // Presne dvadsať záložiek v CELOM menu (issue 387 E5 pridalo "Párovanie",
  // E8 odstránilo "Vypredané → Skladom: návrhy odkazov", issue 400/E9
  // odstránilo "Párovanie produktov", issue 437 pridalo "Poznámky" — 19 → 20).
  await expect(page.locator(".side-nav .tab")).toHaveCount(20);
  await expect(page.getByRole("button", { name: "Sync zo Shoptetu" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Texty e-mailov" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Na objednanie" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Objednávky predajňa" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nevyzdvihnuté zásielky" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pripomienky objednávok" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nedostupné tovary" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Výmena tovaru" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Vrátený tovar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reklamácie" })).toBeVisible();
  // issue 387 E5: záložka "Párovanie" — jej VLASTNÝ odznakový aria-label
  // ("Párovanie Párovanie: N") kolíduje s jej vlastným accessible name (ani
  // `exact: true`, ani obyčajný substring `getByRole` ju jednoznačne
  // nenájdu), preto `data-testid` (`Sidebar.tsx`'s `nav-tab-${tab.id}`),
  // nie `getByRole`. issue 400 (E9) odstránilo predtým kolidujúcu
  // "Párovanie produktov" (#239) — ten dôvod pre `data-testid` tu už
  // neplatí, ale vlastný-badge dôvod stále áno.
  await expect(page.getByTestId("nav-tab-pairing-review")).toBeVisible();
  await expect(page.getByRole("button", { name: "Vyhľadať" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zlúčenie objednávok" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upozornenia" })).toBeVisible();
  // issue 445: „Preprava DPD" presunutá do „Dôležité" pod „Poznámky",
  // premenovaná na „Objednať DPD"; nesie odznak počtu, takže accessible name
  // by mal jeho suffix — `data-testid` (vzor `nav-tab-pairing-review`).
  await expect(page.getByTestId("nav-tab-dpd")).toBeVisible();
  await expect(page.getByRole("button", { name: "Úlohy na dnes" })).toBeVisible();
  // issue 437: nová záložka "Poznámky" v priečinku "Dôležité".
  await expect(page.getByRole("button", { name: "Poznámky" })).toBeVisible();

  // issue 302: predvolená obrazovka (bez kliknutia) je odvtedy "Na
  // objednanie", nie "Sync zo Shoptetu". `scripts/e2e-setup.ts` vždy seeduje
  // dve otvorené objednávky (`orders.spec.ts`'s prvý test) — táto obrazovka
  // teda NIKDY nie je prázdna v E2E prostredí, overujeme preto skutočne
  // prítomnú skupinu dodávateľa, nie prázdny stav.
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();
  await expect(page.getByTestId("supplier-DODAVATEL-TEST-1")).toBeVisible();

  // issue 147: odznak počtu nevybavených riadkov v ľavom menu — musí ostať
  // viditeľný AJ po prepnutí SPÄŤ na inú záložku (odznak žije v `App.tsx`
  // koreni cez `OrdersRemainingCountContext`, nie vnútri "Na objednanie",
  // ktorá sa pri prepnutí odmountuje). Presné číslo sa zámerne neoveruje
  // (zdieľaná globálna DB, iné súbežne bežiace e2e súbory menia stavy
  // riadkov) — len že odznak existuje a nesie platné celé číslo.
  await page.getByRole("button", { name: "Sync zo Shoptetu" }).click();
  await expect(page.getByRole("heading", { name: "Sync zo Shoptetu" })).toBeVisible();
  const odznak = page.getByTestId("nav-badge-orders");
  await expect(odznak).toBeVisible();
  await expect(odznak).toHaveText(/^\d+$/);

  // issue 267: rovnaký odznak vzor pre "Upozornenia" — na rozdiel od
  // "Na objednanie" je toto číslo známe HNEĎ po prihlásení (`App.tsx` si ho
  // fetchuje priamo, nie cez mount-only context), takže je viditeľné aj bez
  // toho, aby test tú záložku vôbec otvoril. Presné číslo sa opäť
  // zámerne neoveruje (zdieľaná globálna DB).
  const upozornOdznak = page.getByTestId("nav-badge-upozornenia");
  await expect(upozornOdznak).toBeVisible();
  await expect(upozornOdznak).toHaveText(/^\d+$/);

  // issue 185: tri obrazovky, ktoré dovtedy sedeli len v `HIDDEN_TABS` — klik
  // na každú otvorí svoju obrazovku (samostatný `<h1>` titulok v Topbar-e,
  // žiadny duplicitný `<h2>` — obrazovky si ho pri presune odstránili). Dve z
  // nich sú v priečinku "Automatizácie", "Nedostupné tovary" je od issue 195
  // pod "Eshop" (nemá naplánovanú úlohu ani prepínač zapnuté/vypnuté).
  await page.getByRole("button", { name: "Nevyzdvihnuté zásielky" }).click();
  await expect(page.getByRole("heading", { name: "Nevyzdvihnuté zásielky" })).toBeVisible();
  // `scripts/e2e-setup.ts` seeduje obe automatizácie ako vypnuté, ale
  // `posta-uncollected.spec.ts`/`order-reminder.spec.ts` bežia ako SAMOSTATNÉ
  // súbory na tej istej zdieľanej DB (možno súbežne, iný Playwright worker) a
  // dočasne si Štart/Stop prepnú na "Beží" a naspäť — rovnaký dôvod, prečo
  // `nav-badge-orders` nižšie neoveruje presné číslo (odznak počtu), len že
  // odznak nesie PLATNÚ hodnotu. Rovnaká disciplína tu: over, že pill nesie
  // jeden z dvoch platných stavov, nie konkrétnu hodnotu.
  await expect(page.getByTestId("nav-status-posta-uncollected")).toHaveText(/^(Zastavené|Beží)$/);

  await page.getByRole("button", { name: "Pripomienky objednávok" }).click();
  await expect(page.getByRole("heading", { name: "Pripomienky objednávok" })).toBeVisible();
  await expect(page.getByTestId("nav-status-order-reminder")).toHaveText(/^(Zastavené|Beží)$/);

  // issue 447: pilulka „Beží"/„Zastavené" musí byť pri VŠETKÝCH
  // automatizáciách. `restock` („Vypredané → Skladom") je togglovaná rovnako
  // ako posta/order-reminder (Štart/Stop) — rovnaká shared-state disciplína
  // (regex, nie presná hodnota, `restock.spec.ts` si ju môže dočasne prepnúť).
  await expect(page.getByTestId("nav-status-restock")).toHaveText(/^(Zastavené|Beží)$/);
  // Always-on plánované joby `sync` („Sync zo Shoptetu") a `supplier-stock`
  // („Dodávateľský sklad") nemajú Štart/Stop prepínač — pilulka je preto VŽDY
  // „Beží", nikdy „Zastavené" (žiadny súbežný spec ju nevie prepnúť).
  await expect(page.getByTestId("nav-status-sync")).toHaveText("Beží");
  await expect(page.getByTestId("nav-status-supplier-stock")).toHaveText("Beží");

  await page.getByRole("button", { name: "Nedostupné tovary" }).click();
  await expect(page.getByRole("heading", { name: "Nedostupné tovary" })).toBeVisible();
  // "Nedostupné tovary" nemá koncept zapnuté/vypnuté vôbec (je len na
  // požiadanie) — žiadny stavový odznak v menu, ani "Zastavené".
  await expect(page.getByTestId("nav-status-nedostupne")).toHaveCount(0);

  // issue 290: rovnaký dôvod ako "Nedostupné tovary" vyššie — žiadny
  // plán/zapnuté-vypnuté koncept, teda žiadny stavový odznak v menu (majú
  // však odznak POČTU nevybavených, funkčne overený v `order-flags.spec.ts`).
  await page.getByRole("button", { name: "Výmena tovaru" }).click();
  await expect(page.getByRole("heading", { name: "Výmena tovaru" })).toBeVisible();
  await expect(page.getByTestId("nav-status-exchange")).toHaveCount(0);

  await page.getByRole("button", { name: "Vrátený tovar" }).click();
  await expect(page.getByRole("heading", { name: "Vrátený tovar" })).toBeVisible();
  await expect(page.getByTestId("nav-status-returned")).toHaveCount(0);

  await page.getByRole("button", { name: "Reklamácie" }).click();
  await expect(page.getByRole("heading", { name: "Reklamácie" })).toBeVisible();
  await expect(page.getByTestId("nav-status-claims")).toHaveCount(0);

  // issue 240: rovnaký dôvod ako "Nedostupné tovary" vyššie — žiadny
  // plán/zapnuté-vypnuté koncept, teda žiadny stavový odznak v menu.
  await page.getByRole("button", { name: "Vyhľadať" }).click();
  await expect(page.getByRole("heading", { name: "Vyhľadať" })).toBeVisible();
  await expect(page.getByTestId("nav-status-search")).toHaveCount(0);

  // issue 257: rovnaký dôvod ako "Vyhľadať" vyššie — žiadny plán/zapnuté-
  // vypnuté koncept, teda žiadny stavový odznak v menu.
  await page.getByRole("button", { name: "Zlúčenie objednávok" }).click();
  await expect(page.getByRole("heading", { name: "Zlúčenie objednávok" })).toBeVisible();
  await expect(page.getByTestId("nav-status-order-merge")).toHaveCount(0);

  // issue 267: rovnaký dôvod ako "Zlúčenie objednávok" vyššie — žiadny
  // plán/zapnuté-vypnuté koncept, teda žiadny stavový odznak v menu (má
  // však odznak POČTU, overený vyššie pri "Sync zo Shoptetu").
  await page.getByRole("button", { name: "Upozornenia" }).click();
  await expect(page.getByRole("heading", { name: "Upozornenia" })).toBeVisible();
  await expect(page.getByTestId("nav-status-upozornenia")).toHaveCount(0);

  // issue 342: rovnaký dôvod ako "Upozornenia" vyššie — žiadny plán/zapnuté-
  // vypnuté koncept, teda žiadny stavový odznak v menu. Obrazovka je teraz
  // súčasťou priečinka "Dôležité" (rozbalený predvolene, žiadny extra klik).
  await page.getByRole("button", { name: "Úlohy na dnes" }).click();
  await expect(page.getByRole("heading", { name: "Úlohy na dnes" })).toBeVisible();
  await expect(page.getByTestId("nav-status-ulohy")).toHaveCount(0);

  // issue 190: zbalenie panela do úzkej lišty. Zámerne je to SÚČASŤ tohto
  // testu, nie samostatný test — každý ďalší test v tomto súbore by znamenal
  // ďalšie prihlásenie na zdieľanom `MAX_ATTEMPTS=10` rozpočte
  // (`login-rate-limit.ts`, viď komentár pri `E2E_NAV_EMAIL` vyššie);
  // `page.reload()` nižšie relácia prežije, takže tu žiadne pribúda.
  const panel = page.locator(".sidebar");
  const obsah = page.locator(".main");
  const prepinac = page.getByTestId("sidebar-rail-toggle");
  const panelRozbaleny = (await panel.boundingBox())?.width ?? 0;
  const obsahRozbaleny = (await obsah.boundingBox())?.width ?? 0;

  await prepinac.click();
  await expect(panel).toHaveClass(/sidebar-rail/);

  // Panel je naozaj užší a obsah vpravo sa do uvoľneného miesta roztiahol.
  const panelZbaleny = (await panel.boundingBox())?.width ?? 0;
  const obsahZbaleny = (await obsah.boundingBox())?.width ?? 0;
  expect(panelZbaleny).toBeLessThan(panelRozbaleny);
  expect(obsahZbaleny).toBeGreaterThan(obsahRozbaleny);

  // Hlavičky priečinkov zmiznú, ikony všetkých modulov ostanú.
  await expect(page.getByRole("button", { name: "Systém" })).toHaveCount(0);
  await expect(page.locator(".side-nav .tab")).toHaveCount(20);
  // Názov sa v lište ukáže bublinou pri prejdení myšou.
  await expect(page.getByRole("button", { name: "Na objednanie" })).toHaveAttribute(
    "title",
    "Na objednanie",
  );

  // Voľba prežije obnovenie stránky.
  await page.reload();
  await expect(page.locator(".sidebar")).toHaveClass(/sidebar-rail/);

  // Vrátiť do pôvodného stavu — panel sa rozbalí a názvy sa vrátia.
  await page.getByTestId("sidebar-rail-toggle").click();
  await expect(page.locator(".sidebar")).not.toHaveClass(/sidebar-rail/);
  await expect(page.getByRole("button", { name: "Systém" })).toBeVisible();

  expect(chyby).toEqual([]);
});

// #57: obrazovka konsoliduje "čo a kedy sa naposledy stiahlo zo Shoptetu" +
// tlačidlo na okamžité stiahnutie — dnes roztrúsené (tlačidlo v katalógu,
// história v plánovači). `scripts/e2e-setup.ts` nespúšťa žiaden scheduler tick
// pre OBJEDNÁVKY a katalógový snapshot pre `catalog.spec.ts` vkladá priamo
// (obchádza scheduler) — kanál "Objednávky" je preto pri tomto teste stále
// "zatiaľ nikdy". Kanál "Katalóg" ale #115 seeduje UMELO ZOSTARNUTÝM,
// úspešným `job_run` (2020, hlboko v minulosti, produkčných dát sa to
// netýka) — presne to, čo umožňuje overiť staleness upozornenie naživo cez
// skutočný prehliadač, bez zásahu do reálnych dát.
test("Sync zo Shoptetu ukazuje stav katalógu aj objednávok a tlačidlo 'Stiahnuť teraz', konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_NAV_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  // issue 302: predvolená obrazovka po prihlásení je odvtedy "Na
  // objednanie", nie "Sync zo Shoptetu" — tento test overuje práve obrazovku
  // "Sync zo Shoptetu", takže tam teraz musí prejsť explicitným klikom.
  // issue 343: priečinok "Systém" štartuje zbalený — treba ho najprv rozbaliť.
  await page.getByRole("button", { name: "Systém" }).click();
  await page.getByRole("button", { name: "Sync zo Shoptetu" }).click();
  await expect(page.getByRole("heading", { name: "Sync zo Shoptetu" })).toBeVisible();

  // #115: katalóg má seedovaný, roky starý úspešný beh — pill NESMIE ukázať
  // "✅ OK", musí ukázať zastaraný/varovný stav so slovenským vysvetlením
  // (nie "zatiaľ nikdy" — ten beh SKUTOČNE prebehol, len je príliš starý).
  const katalog = page.getByTestId("sync-channel-Katalóg");
  await expect(katalog.locator(".pill")).not.toHaveText("✅ OK");
  await expect(page.getByTestId("sync-stale-Katalóg")).toContainText("Posledný úspešný sync");
  await expect(katalog.getByRole("button", { name: "⚡ Stiahnuť teraz" })).toBeVisible();

  const objednavky = page.getByTestId("sync-channel-Objednávky");
  await expect(objednavky).toContainText("Posledný beh: zatiaľ nikdy");
  await expect(objednavky.getByRole("button", { name: "⚡ Stiahnuť teraz" })).toBeVisible();

  // História už nie je prázdna (katalógový beh vyššie) — "sync-history-empty"
  // testid sa preto už nevykresľuje; namiesto neho overíme priamo riadok.
  await expect(page.getByTestId("sync-job-catalog-import")).toBeVisible();

  expect(chyby).toEqual([]);
});
