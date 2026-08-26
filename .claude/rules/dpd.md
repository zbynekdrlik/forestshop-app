---
paths:
  - "apps/api/src/modules/dpd/**"
  - "apps/api/src/http/dpd-routes.ts"
  - "apps/api/tests/dpd-http.integration.test.ts"
  - "apps/web/src/dpdApi.ts"
  - "apps/web/src/components/DpdSection.tsx"
  - "apps/web/tests/e2e/dpd.spec.ts"
  - "scripts/e2e-fixtures-dpd.ts"
---

# DPD preprava (issue 292)

- **Portál `dpdshipper.sk` zmapovaný naživo (read-only guard, 7.8.2026):**
  menu `Zásielky (/shipments) / Objednávky zvozu (/pickup-orders,
  "Pravidelný zvoz" + "Jednorazové zvozy") / Príjemcovia (/recipients) /
  Nastavenia / Importné profily (/import-profiles)`. Prihlásenie je
  `/login`, jedno pole meno + jedno heslo, žiadna CAPTCHA/2FA. Formulár na
  JEDNU zásielku je `/shipments/0` ("Pridať objednávku"). **Prihlasovacie
  selektory SÚ naživo overené a fungujú** (`modules/dpd/login.ts`):
  `input[name=loginName], #loginName` / `input[type=password]` /
  `button:has-text('Prihlásiť'), input[type=submit]`, úspech = presmerovanie
  na `/shipments` + prihlasovacie pole zmizne (rovnaká dvojitá istota ako
  Shoptet, `.claude/rules/shoptet-writeback.md`).
- **Importné profily (hromadný súborový import zásielok) boli na účte
  PRÁZDNE — presný formát súboru sa dá zistiť len ZALOŽENÍM profilu, čo je
  ZÁPIS.** Bezpečnostné pravidlo tohto tiketu (žiadny zápis/objednanie do
  reálneho DPD účtu z vývojárskej session) preto vylúčilo hromadný import
  ako cestu — appka ide per-zásielkovým formulárom (`/shipments/0`).
  Ak sa niekedy neskôr profil založí (majiteľom, naživo), bulk import cez
  Importné profily zostáva rýchlejšia/spoľahlivejšia alternatíva k
  per-objednávkovému formuláru — over najprv, či medzitým nevznikol profil,
  než sa znova rieši per-formulárová cesta.
- **Formulár `/shipments/0` aj objednávka zvozu `/pickup-orders/0` SÚ naživo
  domapované (9.8.2026, read-only route guard — každý zápis po prihlásení
  tvrdo blokovaný, nič sa neobjednalo/neuložilo)** —
  `modules/dpd/shipment-playwright.ts`'s `fillShipmentFields`/
  `pickup-playwright.ts`'s `fillPickupForm` teraz skutočne vypĺňajú a
  odosielajú. Kľúčové zistenia:
  - **Formulár `/shipments/0` má POVINNÉ rozmery balíka** (`parcelWidth`/
    `Height`/`Length`, cm) — appka ich nikde neukladá (Shoptet export ich
    nemá), preto `preview.ts`'s `DEFAULT_PARCEL_WIDTH_CM`/`HEIGHT_CM`/
    `LENGTH_CM` (appka-vlastné rozumné defaulty, rovnaký vzor ako
    `DEFAULT_PARCEL_WEIGHT_KG`, NIKDY editovateľné v UI).
  - **`.fill()` NEDRŽÍ hodnotu na wijmo widgetoch** (`wj-input-date`,
    `wj-input-number`, appka's vlastný `shp-universal-number-input`) — inak
    vyzerá nastavená (DOM `.value` sedí), ale po prechode kroku wizardu sa
    stratí (Angular model ju neprevzal). Funkčná náhrada, overená naživo
    (hodnota PRETRVALA, DOM trieda `ng-valid`): klik (trojklik) → `Control+A`
    → `keyboard.type()` → `Tab`. Zdieľaný helper `portal-fill.ts`'s
    `typeInto` — použi ho pre KAŽDÉ ďalšie pole na tomto portáli, nikdy
    holé `.fill()` na wijmo/Angular-completer prvok.
  - **Produktový typ (`#product_Home`) aj "Dobierka" (`#service-COD`) sú v
    DOM `disabled`, kým portál sám nedokončí svoj vlastný `/api/products`
    POST po prihlásení** — appka preto čaká (`portal-fill.ts`'s
    `waitUntilEnabled`, timeout) a pri pretrvávajúcom `disabled` zlyhá
    NAHLAS namiesto tichého preskočenia.
  - **Pole na sumu dobierky sa NEDALO naživo bezpečne domapovať** (jeho DOM
    sa vykreslí AŽ po reálnom zaškrtnutí, ktoré v read-only sandboxe zostáva
    trvalo disabled) — `fillCodAmount` preto SPOČÍTA vstupy v tom istom
    `.additional-service` kontajneri PRED zaškrtnutím a čaká, kým sa počet
    GENUINNE zvýši (nie len "prvý input v kontajneri" — code review, issue
    292, PR 324: pôvodná verzia by omylom vybrala AKÝKOĽVEK existujúci
    vstup, test na to naschvál obsahuje aj vopred prítomný "vábiaci" vstup
    v tom istom kontajneri). Ak sa nový vstup neobjaví, zlyhá nahlas.
    **Prvé reálne overenie tejto konkrétnej vetvy (COD zásielka) príde AŽ
    pri prvom skutočnom COD odoslaní majiteľom** — over jej správanie
    vtedy, neber ju za naživo overenú predtým.
  - **`isCod: true` s nezistiteľnou sumou (`codAmount: null`) TERAZ zlyhá
    nahlas namiesto tichého odoslania bez dobierky** (code review, issue
    292, PR 324) — `preview.ts`'s `codAmount` sa dá naparsovať na `null` aj
    pri dobierkovej objednávke (chýbajúce `priceToPay` AJ
    `totalPriceWithVat`); appka to predtým ticho preskočila a kuriér by
    peniaze od zákazníka nevybral. Rovnaká disciplína ako hmotnosť/
    krajina/telefón — neisté = zlyhaj, nikdy nehádaj 0.
  - **Appka podporuje LEN slovenské doručovacie adresy** — krajina sa
    NEVYBERÁ aktívne (portálový default je už "Slovensko", appka nemá
    spoľahlivé mapovanie Shoptet textu na DPD interné číselné ID pre iné
    krajiny), `portal-fill.ts`'s `assertSlovakDeliveryCountry` zlyhá nahlas
    na inej krajine namiesto tichého odoslania so zlou predvolenou —
    volaná VŽDY (aj na `countryName === null` cez `?? ""`, code review PR
    324: predošlá verzia `null` prípad ticho preskočila).
  - **Telefón**: appka posiela LEN národné číslo (`portal-fill.ts`'s
    `normalizePhoneForDpd` odstráni `+421`/`00421`/vedúcu nulu) — predvoľba
    `+421` je v portáli SAMOSTATNÉ pole, appka ho nemení. Kontrola DĹŽKY
    (presne 9 číslic) platí AŽ PO odstránení prefixu, JEDNOTNE pre všetky
    vetvy (code review PR 324: pôvodná verzia validovala dĺžku len v
    jednej vetve, takže napr. "00903123456" — zle zadaná domáca nula
    namiesto medzinárodnej predvoľby — prešlo ako nezmyselné 10-miestne
    číslo).
  - **Číslo zásielky po uložení sa NEDALO naživo overiť skutočným kliknutím**
    (bezpečnostné pravidlo — prvý reálny klik patrí majiteľovi) —
    `readParcelNumberAfterSave` skúša najprv toast/notifikáciu, potom
    zoznam Zásielky filtrovaný podľa referencie (appka posiela
    `externalOrderId` do "Referencia 1", `#referential-info1`).
    **`extractParcelNumber` vyžaduje 10+ číslic A výslovne vylučuje
    zhodu so samotnou referenciou** (code review, issue 292, PR 324:
    appka's referencia — typicky 8-miestne Shoptet objednávkové číslo —
    je v tom riadku VŽDY prítomná, presne preto sa podľa nej riadok
    hľadá; naivné "prvá 8+ miestna číslica" by ju teda mohlo vrátiť
    namiesto skutočného, naživo pozorovaného 14-miestneho čísla zásielky).
    **Toto je jediná časť SHIPMENT flow-u, ktorá zostáva UNVERIFIED až do
    prvého skutočného odoslania majiteľom** — ak sa pri ňom ukáže iný tvar
    výsledku, uprav LEN túto funkciu.
  - **Objednanie zvozu (`pickup-playwright.ts`): "úspech" je NEPRIAMY dôkaz
    (absencia chyby), NIE potvrdený pozitívny signál — DRUHÁ časť flow-u,
    ktorá zostáva UNVERIFIED** (code review, issue 292, PR 324 — dovtedy
    nezdôraznené v tomto súbore, hoci nesie rovnaké riziko ako COD-suma/
    číslo zásielky vyššie). Presný pozitívny "uložené" signál sa nedal
    naživo pozorovať (rovnaké bezpečnostné pravidlo). `checkForPortalError`
    preto kontroluje aj live-overený `#toast-container`/`[id*="toast"]`
    mechanizmus (ten istý, aký appka videla vypisovať systémové správy na
    `/pickup-orders`), aj bežné hádané CSS triedy ako zálohu — kým sa
    skutočný tvar chyby/úspechu neoverí prvým reálnym zvozom, KAŽDÉ
    `ok:true` tu je optimistické, nie potvrdené. **VYRIEŠENÉ issue 491
    (26.8.2026): pozitívny signál = review krok zmizne (`#button-save`
    detached) po Uložení, inak chybový toast → fail-loud; pozri bullet
    „PRVÝ REÁLNY ZVOZ" nižšie.**
  - **Testy** (`tests/helpers/dpd-portal-fixture.ts`) imitujú LEN tvar,
    ktorý appka skutočne ovláda (ID/vnorenie/atribúty naživo domapovaných
    prvkov) — NIKDY sa nedotknú `dpdshipper.sk`. **Fixture login formulár
    MUSÍ mať `name` atribút na poliach** (nie len `id`) — inak skutočný
    `<form method=post>` submit pošle prázdne telo a appka's vlastné
    prihlásenie sa nedá naozaj overiť (zistené pri prvom behu tejto sady
    testov: `body["loginName"]` bolo `undefined`, login "zlyhával" aj so
    správnym heslom — nie appka bug, fixture bug; rovnaká trieda chyby ako
    `shoptet-fixture.ts`'s file-chooser gotcha, over VŽDY, že fixture
    formulár posiela dáta presne tak, ako by ich poslal skutočný
    prehliadač). **Fixture, čo si pri "vytvor si vlastný selektor cez
    zhodu DOM pred/po" domýšľa ROVNAKÝ tvar ako implementácia (code
    review PR 324), test NEDOKÁŽE odhaliť zlý predpoklad** — vždy pridaj
    do fixture aj "vábiaci" prvok (napr. vopred prítomný input v tom
    istom kontajneri), ktorý by naivnú implementáciu (bez skutočného
    PRED/PO porovnania) prezradil.
  - **`portal-fill.ts`'s `runOnDpdPortalPage`** zdieľa CELÝ launch→context→
    page→prihlásenie→`action`→zavri cyklus medzi `shipment-playwright.ts`
    aj `pickup-playwright.ts` (predtým kopírovaný dvakrát skoro doslovne —
    code review PR 324); `typeInto` prijíma AJ už-vyriešený `Locator`
    (nielen selektor reťazec), aby aj polia nájdené za behu (ako COD-suma
    vyššie) mohli ísť tou istou overenou cestou. **`page.waitForFunction`
    s priamym `document` odkazom V TOMTO PRIEČINKU (`apps/api/src`) NIKDY**
    — tsconfig tu nemá DOM lib (rovnaké obmedzenie ako `shoptet-writeback/
    playwright-import.ts`'s `rowTexts` komentár), namiesto toho Playwright's
    vlastné typované `.count()`/`.isDisabled()` polling (vzor `portal-
    fill.ts`'s `waitUntilEnabled`).
- **`secret request` má LEN 600s (10 min) platnosť URL na zadanie hodnoty —
  fired-and-forget nefunguje cez noc.** Pri opakovanom čakaní na
  `DPD_PORTAL_USER`/`PASSWORD` (majiteľ spal) sa muselo volať znova zakaždým,
  keď uplynulo 10 minút — žiadny spôsob "vypýtať raz, počkať hodiny". Pri
  podobnom nočnom čakaní na credential: buď volať `secret request` tesne
  PRED momentom, keď sa reálne bude čítať (nie hodiny vopred), alebo počítať
  s viacnásobným re-requestom a ukladať KAŽDÝ pokus ako `gh issue comment`
  (durable tracking), nie len dúfať v jeden úspešný pokus.
- **Shoptet export nemá samostatný stĺpec "spôsob platby" na objednávke —
  je to `itemName` na `BILLING*` pseudo-riadku**, presne rovnaký trik ako
  `shippingCarrierName` z `SHIPPING*` (issue 172, `.claude/rules/
  orders.md`). Naživo overené (7.8.2026, 90-dňový reálny export, LEN
  agregáty čítané, žiadne PII zapísané nikam): `"Dobierka (hotovosť) + karta
  (len SR)"` (268×), `"V hotovosti"` (9×). `paid`/`amountPaid`/`priceToPay`
  stĺpce sú v reálnom exporte prítomné, ale `paid`/`amountPaid` sú TAKMER
  VŽDY prázdne — appka preto rozpoznáva dobierku podľa toho, či
  `paymentMethodName` obsahuje "dobierka" (case-insensitive,
  `modules/dpd/preview.ts`'s `COD_PAYMENT_NAME_RE`), NIE podľa `paid`/
  `amountPaid`. Ďalší stĺpec, ktorý potrebuje podobnú "je na pseudo-riadku"
  extrakciu, patrí do `parser.ts`'s `extractOrderLevelExtra`/
  `mergeOrderLevelExtra`, rovnaký vzor.
- **`weight` stĺpec exportu je v reálnych dátach TAKMER VŽDY `0`** (obchod
  hmotnosť dôsledne nezapisuje — potvrdené na 90-dňovom vzorku). Appka preto
  NIKDY neposiela nulovú/chýbajúcu hmotnosť portálu — `preview.ts`'s
  `DEFAULT_PARCEL_WEIGHT_KG = "1.00"` je použitá, keď je uložená hodnota
  `null` alebo `<= 0`, a obsluha ju v UI (`DpdSection.tsx`, editovateľný
  `<input type=number>` na riadku) môže pred odoslaním prepísať — appka
  sama NIKDY nehádaje reálnu hmotnosť konkrétneho balíka, len ponúka
  rozumný štartovací bod.
- **"Pripravené na odoslanie" (appka's vlastný zoznam,
  `modules/dpd/queries.ts`'s `listDpdShippableOrders`) filtruje podľa
  `order.package_number IS NULL` (Shoptet nezaznamenal inú prepravu) A
  žiadny `dpd_shipment` riadok so `status = 'submitted'` A objednávka je v
  OTVORENOM stave.** Pôvodne (issue 292) bol zoznam ZÁMERNE nezávislý od
  `status_name` — ale šéf (issue 445, 19.8.2026) videl priveľa objednávok s
  možnosťou objednať DPD, lebo bez stavového filtra kvalifikovali aj
  stornované/vybavené objednávky bez čísla balíka. Stavový filter preto
  ZNOVUPOUŽÍVA ten istý admin-konfigurovateľný `order_open_status`
  mechanizmus ako "Na objednanie" (`listOpenStatusNames`, default
  „Vybavuje sa") — `inArray(orders.statusName, [...openStatuses])`, rovnaký
  idiom ako 5 ostatných modulov. Z konštrukcie tak nikdy neponúkne
  terminálne stavy („Stornovaná"/„Vybavená"/„Vratený tovar"/„Vybavená
  výmena"/„Vybavený Dobropis"), ktoré v open sete nie sú. **Nový hardcoded
  zoznam terminálnych stavov PRIAMO v DPD module bol ZAMIETNUTÝ** (krehký —
  nový terminálny stav v Shoptete by ticho prešiel; duplikuje znalosť, čo
  už žije v `order_open_status`). Obsluha si spomedzi OTVORENÝCH sama vyberie
  reálne zabalené objednávky. `countDpdShippableOrders` (nav badge „Objednať
  DPD", issue 445) používa TÚ ISTÚ zdieľanú `shippableWhere` podmienku, aby
  číslo v menu vždy sedelo s dĺžkou zoznamu.
- **`dpd_shipment` je JEDEN riadok NA OBJEDNÁVKU (`orderId` unique,
  upsert)** — opakovaný pokus (retry po zlyhaní) PREPÍŠE ten istý riadok,
  appka teda vidí len POSLEDNÝ pokus, nikdy históriu pokusov (MVP, netreba
  viac). `dpd_pickup_request` je NAOPAK nezávislý insert na KAŽDÝ pokus
  (jednorazový zvoz nie je viazaný na objednávku, každý deň je samostatná
  udalosť) — nezamieňaj tieto dva vzory pri ďalšom podobnom "appka-vlastný
  záznam pokusu" dizajne.
- **`dpd_shipment` NETREBA pridávať do `tests/helpers/db.ts`/`scripts/
  e2e-setup.ts` TRUNCATE zoznamov — má reálny FK do `"order"` (`onDelete:
  cascade`), takže `TRUNCATE "order" CASCADE` ho strhne automaticky.**
  `dpd_pickup_request` NEMÁ FK v žiadnom smere (dátum-kľúčovaný) — TEN treba
  pridať RUČNE do OBOCH zoznamov (rovnaký test ako `.claude/rules/
  testing.md`'s "nová koreňová tabuľka" pravidlo).
- **HTTP routes injektujú `createShipment`/`orderPickup` ako funkcie
  (`http/dpd-routes.ts`'s `DpdRunDeps`), predvolene skutočný izolovaný
  Playwright robot** — presne rovnaký DI vzor ako `postaUncollected
  .trackingClient`/`nedostupne.mailTransport`, NIE priamy import volaný
  vnútri route handlera. Bez tejto injekcie by `dpd-http.integration
  .test.ts` musel spúšťať skutočný Chromium (pomalé, a riskuje dotknutie sa
  reálneho účtu, keby `config` bol reálny) — testy namiesto toho dodávajú
  falošnú funkciu, appka sa NIKDY nedotkne skutočného DPD portálu z testu.
- **`parseDecimalComma` (`catalog/money.ts`) zaokrúhľuje na PRESNE 2
  desatinné miesta (`roundToTwoDecimals`, hardcoded)** — `order.weight`/
  `dpd_shipment.weight_kg` preto dostali `numeric(_, 2)` presnosť (nie 3,
  ako by sa pre "kg" mohlo zdať prirodzené), aby sedeli s tým, čo parser
  reálne vracia. Ďalší stĺpec parsovaný cez `parseDecimalComma` s inou
  scale ako 2 by ticho strácal presnosť — over `roundToTwoDecimals` PRED
  voľbou `scale` na novom `numeric` stĺpci.
- **E2E test pre "appka je fail-closed bez DPD prihlásenia" (`dpd.spec.ts`)
  je JEDINÝ bezpečný spôsob overiť UI naživo bez credentials** — appka MUSÍ
  zobraziť zoznam (čisto DB čítanie, nezávisí od Playwright robota) a
  zablokovať tlačidlá "Objednať prepravu DPD"/"Objednať zvoz na deň", keď
  `configured: false`. Skutočný preview→confirm→odoslanie flow (kde appka
  by inak volala robota) je pokrytý LEN `DpdSection.test.tsx`'s izolovaným
  falošným API klientom — e2e prostredie nemá a NEMÁ MAŤ `DPD_PORTAL_USER`/
  `PASSWORD` nastavené, presne rovnaká disciplína ako `MAIL_HOST`/
  `SHOPTET_ADMIN_USER` v e2e prostredí (appka sa nikdy nedotkne skutočnej
  tretej strany z testu).
- **Objednanie zvozu má Štěpánov krok 2 „zavrieť všetky hlášky" (info banner
  „Aktuálne obmedzenia…" s ✕) — rieši `portal-fill.ts`'s `dismissInfoBanners`,
  volaný v `pickup-playwright.ts`'s `runOrderDpdPickup` PRED `fillPickupForm`
  (issue 451).** Zámerne fail-SOFT, NIE fail-loud (na rozdiel od povinných
  polí formulára): chýbajúci banner je NORMÁLNY stav, takže helper chyby
  prehltne a na absenciu je no-op; ak by prekrytie predsa zostalo,
  `checkForPortalError` po Uložení aj tak zlyhá nahlas. **Presný selektor
  reálneho bannera je UNVERIFIED** (mapovanie 9.8.2026 bolo read-only a robot
  sa NESMIE spustiť naživo — vytvoril by reálny zvoz), preto ŠIROKÝ tolerantný
  zoznam; scope-nuté selektory (`[class*="banner"] [class*="close"]` …) bežia
  PRVÉ, holé `button:has-text("✕"/"×")` až posledné ako záloha — pri prvom
  reálnom zvoze ich ZÚŽ podľa skutočného DOM (nikdy naslepo, zúženie teraz by
  mohlo scope-núť VON aj skutočný zatvárací prvok). **ZÚŽENÉ issue 491
  (26.8.2026): reálne hlášky sú `shp-newsfeed-toast`, zatvárané
  `.newsfeed-toast__button` „Zatvoriť" (staré hádané selektory nezavreli NIČ);
  `dismissInfoBanners` teraz mieri LEN na `shp-newsfeed-toast
  button:has-text("Zatvoriť")` — pozri bullet „PRVÝ REÁLNY ZVOZ" nižšie.**
  Volá sa LEN v pickup
  vetve — shipment vetva (#292) ostáva nedotknutá. Test: fixtúra
  `dpd-portal-fixture.ts`'s `showInfoBanner` prekryje formulár celoobrazovkovým
  `z-index` overlayom, ktorý zachytí pointer eventy (Playwright „intercepts
  pointer events") — RED bez dismissalu, GREEN s ním; over cez `[aria-label
  "Zavrieť"]`/`[class*=alert] [class*=close]`, nie cez holý ✕ (aby test
  nezávisel od záložného selektora).
- **UI záložky „Objednať DPD": denná preprava (zvoz) je PRIMÁRNA akcia (issue
  451) — tlačidlo „Objednať zvoz na deň" je `btn good lg` a PRVÉ v DOM poradí**
  (nad per-zásielkovým `btn good` „Objednať prepravu DPD" aj nad tabuľkou);
  feedback po zvoze je `<p role="status" data-testid="dpd-pickup-message">`
  (live region ako `dpd-send-notice`). Poradie overuje `DpdSection.test.tsx`
  (`["dpd-pickup-submit","dpd-open-preview","table"]`) aj `dpd.spec.ts`
  (`zvozBox.y < btnBox.y`, boundingBox funguje aj na disabled tlačidle).
  Per-zásielkový úvodný odsek sa presunul dole k svojej sekcii (`orders.length
  > 0`). Badge/per-zásielková logika #445 nedotknuté. Kontakt (Štěpánov krok
  5) sa NEVYBERÁ — účet má jediný predvyplnený kontakt + fail-loud poistka;
  ak by prvý reálny zvoz ukázal, že kontakt treba aktívne vybrať, TU je delta.
- **PRVÝ REÁLNY ZVOZ (issue 491, 26.8.2026) — objednávka zvozu `/pickup-orders/0`
  NAŽIVO domapovaná, a predošlé HÁDANÉ `#step1`/`#step2` boli NESPRÁVNE.**
  Skutočný DOM (read-only remap app credentials z kontajnera, žiadny zápis):
  - Formulár je JEDEN Angular `<form class="data">` (`shp-app ng-version=5.1.3`)
    — zvozová adresa readonly (`#customer-name`/`-street`/`-zip`/`-city`),
    kontakt (`#contact-person` ng2-completer, `#email`, `#phone`), `#note`,
    a **`#pickup-date` = `wj-input-date`** s vnútorným `input[wj-part="input"]`
    (type=tel) — selektor `#pickup-date input[wj-part="input"]` je SPRÁVNY.
    Jediné editovateľné pole, ktoré appka mení, je dátum. Krok 1 má JEDNO
    tlačidlo `#button-confirmation` „Pokračovať".
  - **`#step1`/`#step2` v reálnom DOM NEEXISTUJÚ.** Klik „Pokračovať"
    NEnaviguje (URL ostáva `/pickup-orders/0`) — Angular RE-RENDERuje NA
    MIESTE na REVIEW krok: zmizne `#button-confirmation`, `<form>` sa zmení na
    `<div class="data">`, objaví sa `<div class="panel wide warning">` („Po jej
    uložení bude objednávka odoslaná do DPD…"), polia sú readonly, a pribudnú
    **`#button-save` („Uložiť") + `#button-back` („Späť")** v `.commands.toolbar`.
    Skutočné odoslanie = klik `#button-save`. Starý kód čakal `#step1` hidden
    (prejde triviálne — prvok chýba = hidden) + `#step2` visible (timeout
    8000 ms — nikdy neexistoval) → nahlásená chyba; finálne uloženie sa NIKDY
    nedosiahlo, teda žiadny zvoz sa nevytvoril (sedí s tým, čo videl Štěpán).
    **Fix (`fillPickupForm`):** čakať `#button-save` visible (review marker),
    klik `#button-save`, potom FAIL-LOUD pozitívne overenie — race medzi
    „`#button-save` detached" (navigácia na zoznam / re-render = ÚSPECH) a
    chybovým toastom (ZLYHANIE), nikdy tiché optimistické „ok" (uzatvára
    UNVERIFIED poznámku vyššie o „úspech = absencia chyby").
  - **Info hlášky (Štěpánov krok „zavrieť všetky hlášky") sú
    `shp-newsfeed-toast` toasty v `#toast-container` („Aktuálne obmedzenia a
    možné oneskorenia…", „Nové pravidlá v doručovaní…"), zatvárané tlačidlom
    `.newsfeed-toast__button` s textom „Zatvoriť"** (druhé tlačidlo toastu
    „Obsah správy" je DECOY — otvorilo by správu). Staré hádané selektory
    (`[aria-label=Zavrieť]`/`✕`/`[class*=close]`) nezavreli NIČ. Naživo
    overené: klik `shp-newsfeed-toast button:has-text("Zatvoriť")` zavrel OBA
    toasty (2 → 0). `dismissInfoBanners` ZÚŽENÉ presne na tento selektor
    (loop-close-first, bounded, fail-soft) — pozri `portal-fill.ts`.
  - **Zoznam `/pickup-orders`:** „Jednorazové zvozy" je
    `shp-one-time-pickup-orders-list` (`.one-time-pickups`), tlačidlo „Nová
    objednávka zvozu" = `#add-pickup-order` (naviguje na `/pickup-orders/0`,
    appka's priama navigácia stále platí). Úspešný zvoz = riadok s dátumom
    (`Dátum vyzdvihnutia`) + stav **„Objednávka odoslaná"** (`td.col-date`).
    Zvozová adresa účtu: „Slavosport s.r.o., Brokoffova 1654/8, 05801 Poprad".
  - **Fixtúra `dpd-portal-fixture.ts`'s `pickupFormPage` prerobená na tento
    reálny tvar** (single `<form>` → „Pokračovať" → review s `#button-save`;
    `shp-newsfeed-toast` overlay so „Zatvoriť" + „Obsah správy" DECOY) —
    empiricky RED na starom kóde (5/5 testov padlo, `#step2` timeout / decoy),
    GREEN na novom (5/5). Kontakt sa STÁLE nevyberá (jediný predvyplnený,
    fungovalo naživo).
