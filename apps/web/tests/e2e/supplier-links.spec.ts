import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
// VLASTNÝ izolovaný účet (rovnaký mechanizmus ako `E2E_PREHLAD_EMAIL`/ostatné,
// `.claude/rules/frontend-design.md`) — zdieľaný `e2e@forestshop.sk` je už na
// hranici `MAX_ATTEMPTS`. Musí sa zhodovať s `scripts/e2e-fixtures-product-
// links.ts`'s `E2E_PAROVANIE_EMAIL`.
const E2E_PAROVANIE_EMAIL = "e2e-parovanie@forestshop.sk";

// issue 239: "Eshop → Párovanie produktov" — VIDITEĽNÁ záložka (`nav.ts`,
// skupina Eshop). Fixtúry (`scripts/e2e-fixtures-product-links.ts`): produkt
// "E2E-PL-CHYBA" (žiadny `internalNote`, žiadny override — "doplniť" cesta)
// a "E2E-PL-OPRAVA" (už uložený, ešte NEODOSLANÝ override — "opraviť" cesta).

test("produkt bez linky ponúka 'Doplniť', po uložení sa presunie do 'S linkou' a stav ukazuje čaká na odoslanie; existujúca linka sa dá opraviť, konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  // issue 251 (regresný dôkaz, natrvalo): prehliadka na main CI hneď po
  // mergi issue 241 ukázala presne tento test zlyhať s "element(s) not
  // found" na `product-link-url-E2E-PL-CHYBA" — koreňová príčina je
  // vysvetlená pri `save()` volaní nižšie. Skutočný sieťový race záviselo
  // na náhodnom časovaní (na PR CI dvakrát prešiel, na main raz zlyhal,
  // jeden rerun prešiel čisto), takže bez umelého oneskorenia by tento
  // test regresiu nezachytil spoľahlivo. Tu sa REÁLNY zápis (`saveProduct
  // Link`'s `POST /api/product-links/:productKey`) len o 400ms oneskorí —
  // požiadavka ide naďalej na skutočný server cez pôvodný `fetch`
  // (`puvodny`), žiadna odpoveď sa nefalšuje ani nezamieta, takže toto
  // NIE JE prípad `.claude/rules/testing.md`'s zákazu `page.route()
  // .abort()/.fulfill(4xx/5xx)` (simulácia ZLYHANIA) — ide o rovnaký
  // `window.fetch`-prepichnutý vzor ako `orders-write-failures.spec.ts`,
  // len s oneskorením namiesto s falošnou odpoveďou. Overené opakovane
  // lokálne (`.claude/rules/testing.md`): BEZ opravy nižšie zlyhá
  // spoľahlivo (3/3 samostatných behov), S opravou prejde spoľahlivo
  // (6+/6 samostatných behov) — vždy s týmto oneskorením zapnutým.
  await page.addInitScript(() => {
    const puvodny = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST" && url.includes("/api/product-links/")) {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(puvodny(input, init));
          }, 400);
        });
      }
      return puvodny(input, init);
    };
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_PAROVANIE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await page.getByRole("button", { name: "Párovanie produktov" }).click();
  await expect(page.getByRole("heading", { name: "Párovanie produktov" })).toBeVisible();

  // Predvolený filter je "Bez linky" — fixtúra "E2E-PL-CHYBA" sa tam nájde.
  await page.getByLabel("Hľadať produkt (kód alebo názov)").fill("E2E-PL-CHYBA");
  await page.getByRole("button", { name: "Zobraziť" }).click();

  const riadok = page.getByTestId("product-link-row-E2E-PL-CHYBA");
  await expect(riadok).toBeVisible();
  await expect(riadok).toContainText("E2E Dodávateľ Párovanie");
  await expect(page.getByTestId("product-link-status-E2E-PL-CHYBA")).toHaveText("—");

  await riadok.getByTestId("product-link-edit-toggle-E2E-PL-CHYBA").click();
  const vstup = page.getByTestId("product-link-edit-input-E2E-PL-CHYBA");
  await expect(vstup).toBeVisible();
  await expect(vstup).toHaveValue("");
  await vstup.fill("https://e2e-dodavatel.example.com/parovanie-nova");
  await page.getByTestId("product-link-save-E2E-PL-CHYBA").click();

  // issue 251: PRED opravou `save()` v `SupplierLinksSection.tsx` volal vo
  // svojom `.then()` VLASTNÝ `refetch()`, ktorého uzáver mal PRIVIAZANÝ
  // filter ("Bez linky") z okamihu KLIKNUTIA na Uložiť — nie aktuálny
  // filter. Test tu ZÁMERNE prepína filter na "Všetky" a znova vyhľadáva
  // BEZ ČAKANIA na potvrdenie zápisu (žiadne umelé oneskorenie kroku) — to
  // je presne poradie udalostí, ktoré pôvodný bug reprodukovalo.
  //
  // Test je deterministický AJ BEZ tohto čakania (a teda aj bez ohľadu na
  // to, či 400ms-oneskorená PATCH odpoveď doletí PRED alebo AŽ PO tomto
  // prepnutí), lebo oprava odstránila samotný RACE, nie len jeho jedno
  // konkrétne časovanie: `refetch()` teraz vždy číta AKTUÁLNY filter/dopyt
  // (cez ref, pozri komentár pri `queryRef`/`stateRef` v komponente), nie
  // ten zafixovaný v okamihu kliknutia na Uložiť. Ak teda `.then()`'s
  // `refetch()` doletí AŽ PO tom, čo test prepol filter, zavolá `search`
  // s TÝM ISTÝM ("Všetky") filtrom, aký použil aj testov vlastný dopyt —
  // dve vyhľadania s ROVNAKÝM filtrom pretekajúce sa o `searchSeq` dávajú
  // rovnaký (správny) výsledok bez ohľadu na to, ktoré vyhrá. Skorší tvar
  // tohto testu mal namiesto tohto vysvetlenia `await
  // expect(vstup).toBeHidden()` explicitné čakanie PRED prepnutím filtra —
  // code review upozornil, že takéto čakanie zoslabuje testovaciu silu
  // (test by prešiel, aj keby sa oprava komponentu vrátila naspäť, lebo by
  // vždy garantovalo bezpečné poradie bez ohľadu na to, či je race v
  // komponente skutočne opravený) — preto bolo odstránené a test teraz
  // dokazuje SKUTOČNÚ opravu, nie len bezpečné testové časovanie.

  // Po uložení produkt už MÁ linku — predvolený filter "Bez linky" ho už
  // nezobrazí, treba prepnúť na "Všetky", aby bolo vidno stav.
  await page.getByLabel("Zobraziť produkty").selectOption("all");
  await page.getByRole("button", { name: "Zobraziť" }).click();
  const riadokPoUlozeni = page.getByTestId("product-link-row-E2E-PL-CHYBA");
  await expect(riadokPoUlozeni.getByTestId("product-link-url-E2E-PL-CHYBA")).toHaveAttribute(
    "href",
    "https://e2e-dodavatel.example.com/parovanie-nova",
  );
  await expect(page.getByTestId("product-link-status-E2E-PL-CHYBA")).toContainText("čaká na odoslanie");

  // Pretrvanie po obnovení stránky — linka je v DB
  // (`product_supplier_link_override`), nielen v optimistickom klientskom stave.
  await page.reload();
  await page.getByLabel("Zobraziť produkty").selectOption("all");
  await page.getByLabel("Hľadať produkt (kód alebo názov)").fill("E2E-PL-CHYBA");
  await page.getByRole("button", { name: "Zobraziť" }).click();
  await expect(page.getByTestId("product-link-url-E2E-PL-CHYBA")).toHaveAttribute(
    "href",
    "https://e2e-dodavatel.example.com/parovanie-nova",
  );

  // Existujúca (fixtúrová) linka "E2E-PL-OPRAVA" — filter "S linkou", ✏️
  // Upraviť ponúkne AKTUÁLNU hodnotu ako predvyplnenú, nová hodnota prepíše
  // pôvodnú bez akejkoľvek "už má hodnotu" gaty.
  await page.getByLabel("Zobraziť produkty").selectOption("linked");
  await page.getByLabel("Hľadať produkt (kód alebo názov)").fill("E2E-PL-OPRAVA");
  await page.getByRole("button", { name: "Zobraziť" }).click();
  const riadokOprava = page.getByTestId("product-link-row-E2E-PL-OPRAVA");
  await expect(riadokOprava.getByTestId("product-link-url-E2E-PL-OPRAVA")).toHaveAttribute(
    "href",
    "https://e2e-dodavatel.example.com/parovanie-oprava-povodna",
  );
  await expect(page.getByTestId("product-link-status-E2E-PL-OPRAVA")).toContainText("čaká na odoslanie");

  await riadokOprava.getByTestId("product-link-edit-toggle-E2E-PL-OPRAVA").click();
  const vstupOprava = page.getByTestId("product-link-edit-input-E2E-PL-OPRAVA");
  await expect(vstupOprava).toHaveValue("https://e2e-dodavatel.example.com/parovanie-oprava-povodna");
  await vstupOprava.fill("https://e2e-dodavatel.example.com/parovanie-oprava-nova");
  await page.getByTestId("product-link-save-E2E-PL-OPRAVA").click();

  await expect(page.getByTestId("product-link-url-E2E-PL-OPRAVA")).toHaveAttribute(
    "href",
    "https://e2e-dodavatel.example.com/parovanie-oprava-nova",
  );

  expect(chyby).toEqual([]);
});

// issue 153 (rovnaká disciplína ako `orders-supplier-link.spec.ts`): neplatný
// odkaz sa odmietne HNEĎ v prehliadači — konzola musí zostať čistá (dôkaz, že
// sa nikdy neodoslal skutočný request na server).
test("neplatný odkaz sa odmietne HNEĎ, bez zápisu na server (konzola čistá)", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=supplier-links");
  await page.getByLabel("E-mail").fill(E2E_PAROVANIE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Párovanie produktov" })).toBeVisible();

  await page.getByLabel("Zobraziť produkty").selectOption("all");
  await page.getByLabel("Hľadať produkt (kód alebo názov)").fill("E2E-PL-OPRAVA");
  await page.getByRole("button", { name: "Zobraziť" }).click();

  const riadok = page.getByTestId("product-link-row-E2E-PL-OPRAVA");
  await riadok.getByTestId("product-link-edit-toggle-E2E-PL-OPRAVA").click();
  const vstup = page.getByTestId("product-link-edit-input-E2E-PL-OPRAVA");
  await vstup.fill("nieje-url");
  await page.getByTestId("product-link-save-E2E-PL-OPRAVA").click();

  await expect(page.getByText("Odkaz musí byť platná adresa začínajúca http:// alebo https://.")).toBeVisible();

  expect(chyby).toEqual([]);
});

// issue 251 (code review finding 1, nájdené AŽ po merge PR #253): `busyKey`
// blokuje LEN tlačidlá vlastného riadku — "Upraviť"/"Doplniť" na VŠETKÝCH
// OSTATNÝCH riadkoch ostáva aktívne. Ak počas čakania na PATCH odpoveď
// riadku A užívateľ otvorí editor riadku B, `editingKey` sa presunie na B —
// keď A's `.then()` napokon doletí, jeho PÔVODNÝ (pred touto opravou)
// nepodmienený `setEditingKey(null)` ticho ZATVORÍ B's PRÁVE otvorený
// editor a stratí, čo tam bolo rozpísané. Rovnaký oneskorovací vzor ako
// vyššie (`window.fetch` prepichnutý cez `addInitScript`, REÁLNA odpoveď
// len o 400ms neskôr, žiadny fake/mock).
test("uloženie riadku A (ešte čakajúce na odpoveď) nesmie zavrieť editor riadku B otvorený medzitým", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.addInitScript(() => {
    const puvodny = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST" && url.includes("/api/product-links/")) {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(puvodny(input, init));
          }, 400);
        });
      }
      return puvodny(input, init);
    };
  });

  await page.goto("/?tab=supplier-links");
  await page.getByLabel("E-mail").fill(E2E_PAROVANIE_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Párovanie produktov" })).toBeVisible();

  // "Všetky" + spoločný dopyt "E2E-PL" nájde OBA fixtúrové riadky naraz —
  // netreba prepínať filter medzi otvorením A a B, čo by samo osebe
  // vyvolalo ĎALŠIE vyhľadanie a scenár skomplikovalo.
  await page.getByLabel("Zobraziť produkty").selectOption("all");
  await page.getByLabel("Hľadať produkt (kód alebo názov)").fill("E2E-PL");
  await page.getByRole("button", { name: "Zobraziť" }).click();

  const riadokA = page.getByTestId("product-link-row-E2E-PL-CHYBA");
  const riadokB = page.getByTestId("product-link-row-E2E-PL-OPRAVA");
  await expect(riadokA).toBeVisible();
  await expect(riadokB).toBeVisible();

  // A: otvoriť editor, vyplniť platnú adresu, uložiť — reálna PATCH
  // odpoveď beží 400ms na pozadí. `waitForResponse` sa musí založiť PRED
  // kliknutím na Uložiť, aby nezmeškal odpoveď, ktorá môže doraziť skôr,
  // než by sme naň začali čakať.
  const odpovedA = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().includes("/api/product-links/E2E-PL-CHYBA"),
  );
  await riadokA.getByTestId("product-link-edit-toggle-E2E-PL-CHYBA").click();
  await page
    .getByTestId("product-link-edit-input-E2E-PL-CHYBA")
    .fill("https://e2e-dodavatel.example.com/parovanie-cross-row");
  await page.getByTestId("product-link-save-E2E-PL-CHYBA").click();

  // B: kým A ešte čaká na odpoveď, otvoriť JEHO editor.
  await riadokB.getByTestId("product-link-edit-toggle-E2E-PL-OPRAVA").click();
  const vstupB = page.getByTestId("product-link-edit-input-E2E-PL-OPRAVA");
  await expect(vstupB).toBeVisible();

  // Počkať na SKUTOČNÚ sieťovú odpoveď A-čka (deterministické, nezávislé od
  // toho, čo so stavovým riadkom urobili PREDCHÁDZAJÚCE testy v tomto
  // súbore — na rozdiel od kontroly textu stavu, ktorý môže byť "čaká na
  // odoslanie" už PRED touto akciou vďaka staršej fixtúrovej mutácii).
  // Krátka rezerva navyše necháva doriešiť React-ov `.then()`/render
  // reťazec, ktorý nasleduje AŽ PO tom, čo odpoveď doletí.
  await odpovedA;
  await page.waitForTimeout(200);

  // B's editor musí ostať otvorený — A's `.then()` nesmie zavrieť CUDZÍ
  // (v tomto momente už nesúvisiaci) editor. Toto je JEDNORAZOVÁ kontrola
  // aktuálneho stavu (nie `expect().toBeVisible()`'s auto-retry, ktoré by
  // stačilo zachytiť VIDITEĽNÝ prvok len na okamih a prešlo by aj keby sa
  // hneď potom skryl).
  expect(await vstupB.isVisible()).toBe(true);

  expect(chyby).toEqual([]);
});
