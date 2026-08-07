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
- **Presné selektory formulára `/shipments/0` NIE SÚ domapované** — appka
  (`modules/dpd/shipment-playwright.ts`'s `fillShipmentFields`,
  `pickup-playwright.ts`'s `fillPickupForm`) zámerne zlyhá NAHLAS s presným
  popisom namiesto TICHÉHO odoslania vymyslených polí. Dôvod: dopĺňanie
  chýbajúceho DPD prihlásenia (`secret request`) cez noc nikdy neprišlo —
  žiaden ďalší pokus nesmie NAHRADIŤ tento fail-loud vzor odhadnutými
  selektormi, aj keby "vyzerali rozumne" (DPD Shipper vocabular nie je
  overený, hádanie by tichým zlyhaním vyzeralo ako úspech alebo poslalo zlé
  dáta). **Prvé ďalšie použitie tohto modulu MUSÍ najprv urobiť READ-ONLY
  naživo mapovanie** (rovnaký `readOnly` route-guard vzor ako
  `dpd-mapuj.mjs`/`dpd-formulare.mjs` v scratchpad histórii issue 292 —
  `let readOnly=false; ctx.route("**/*", …); readOnly=true;` hneď po
  prihlásení) PRED doplnením skutočných selektorov do `fillShipmentFields`/
  `fillPickupForm` — nikdy priamo skúšať naostro.
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
  `modules/dpd/queries.ts`'s `listDpdShippableOrders`) je ZÁMERNE nezávislé
  od Shoptet `status_name`** — appka nemá spoľahlivý zoznam stavov "zabalené,
  čaká na kuriéra" (na rozdiel od "Na objednanie"'s `order_open_status`,
  ktorý rieši INÝ problém — dodávateľské objednávanie). Kritérium je
  namiesto toho appka-vlastné: `order.package_number IS NULL` (Shoptet
  nezaznamenal inú prepravu) A žiadny `dpd_shipment` riadok so `status =
  'submitted'`. Obsluha si sama vyberie, ktoré reálne zabalené objednávky
  odošle — ĎALŠIA funkcia, čo by potrebovala podobný "ešte neriešené"
  filter, nech zváži rovnaký princíp (appka-vlastný stavový záznam) skôr
  než sa spolieha na Shoptet `status_name`, ktorý na to nemá spoľahlivý
  slovník.
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
