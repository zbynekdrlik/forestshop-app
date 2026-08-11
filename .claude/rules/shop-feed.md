---
paths:
  - "apps/api/src/modules/shop-feed/**"
  - "apps/web/src/shopLinks.ts"
---

# Adresy našich produktov z feedu pre porovnávače (issue 220)

- **`https://www.forestshop.sk/google.xml` je JEDINÝ známy verejný zdroj, ktorý
  má naraz náš kód variantu aj priamu adresu detailu.** Je to Shoptetom
  generovaný Google Merchant feed: `<g:id>` je presne `variant.code` vrátane
  veľkosti (`40237/M`) a `<link>` nesie aj `?variantId=…`, takže otvorí rovno
  správnu veľkosť. Adresa je verejná — **nenesie prihlasovací údaj**, na rozdiel
  od `SHOPTET_EXPORT_URL`, takže smie byť v repozitári.
- **Ostatné feedy na tejto doméne NEEXISTUJÚ** — overené 4. 8. 2026:
  `/heureka.xml`, `/zbozi.xml`, `/feed.xml`, `/export/products.xml`,
  `/googlemerchant.xml`, `/export/google.xml` všetky vracajú 404. Funguje len
  `/google.xml` a `/sitemap.xml`. Nehľadať znova naslepo.
- **Feed nepokrýva celý katalóg — 7 666 položiek proti 8 279 viditeľným
  variantom.** 626 viditeľných variantov v ňom nie je. Preto je napojenie do
  `restock/queries.ts` `LEFT JOIN` a frontend má náhradu (`ourProductLink`
  padne na vyhľadávanie podľa kódu). Zmena na `INNER JOIN` by zo zoznamu, podľa
  ktorého majiteľ rozhoduje, ticho vyhodila stovky riadkov — presne tá trieda
  chyby, ktorú riešilo issue 219.
- **`shop_product_url` odteraz nesie aj `g:availability`
  (`availability`, nullable text, issue 226) — Shoptetova VLASTNÁ dostupnosť,
  nezávislý zdroj pravdy na krížovú kontrolu proti nášmu odvodenému
  `variant.state`** (`modules/catalog/feed-cross-check.ts`). Živo overené
  4. 8. 2026: len dve reálne hodnoty na tomto e-shope, `"in stock"`/
  `"out of stock"` (7 449/139 z 7 679 položiek), zvyšných 91 má prázdnu
  značku → `null`. `runShopFeed`'s UPSERT PREPISUJE `availability` na
  KAŽDOM behu (vrátane `null`), inak by stará hodnota z predošlého behu
  ticho prežívala a krížová kontrola by porovnávala proti zastaranému
  signálu.
- **Nová "koreňová" tabuľka pridaná do TRUNCATE zoznamu (`.claude/rules/
  testing.md`) MUSÍ pribudnúť do OBOCH zoznamov, aj keď existuje už dávno —
  `shop_product_url` (issue 220) chýbala v `scripts/e2e-setup.ts`'s vlastnom
  TRUNCATE reťazci celé mesiace, lebo dovtedy do nej žiadny e2e seed
  nezapisoval.** Odhalené AŽ issue 226, keď prvý e2e seed (`PREP-2`'s
  rozporová `availability`) do tejty tabuľky skutočne zapísal — bez FK na
  `variant` (tabuľka je zámerne PLOCHÁ) sa jej riadky NEVYPRÁZDNIA cez
  `variant`'s CASCADE, takže by ticho prežívali medzi e2e behmi. Test pri
  KAŽDEJ tabuľke bez FK, ktorú založí SKORŠÍ ticket: skús do nej niečo
  zapísať v `scripts/e2e-setup.ts` a over `grep shop_product_url
  scripts/e2e-setup.ts` (alebo cieľovú tabuľku) PRED spoliehaním sa na to,
  že tam už je.
- **Rozoberač je zámerne regulárny výraz bez novej závislosti na XML parseri.**
  Tvar feedu je plochý (`<entry>` s textovými deťmi). Hlavička feedu má
  `<link href="…" />` s adresou vzorového webu — preto vzor hľadá `<link>` s
  KONCOVOU značkou, inak by sa do mapy dostal `example.com`.
- **`MIN_ENTRIES` je poistka proti tichému vyprázdneniu mapy.** Keď feed vráti
  menej než 1 000 použiteľných položiek, beh vyhodí a do tabuľky NEZAPÍŠE —
  inak by jeden pokazený beh zmazal adresy a odkazy by sa ticho vrátili na
  vyhľadávanie. Riadky, ktoré feed už neobsahuje, sa zámerne NEMAŽÚ: stará
  platná adresa je lepšia než žiadna.
- **issue 347: `image_url` (nullable, additive migrácia) — obrázok produktu
  z `<g:image_link>`, rovnaká disciplína ako `availability` (UPSERT
  prepíše na aktuálnu hodnotu vrátane `null`, keď feed značku stratí).
  Používa ho `nedostupne/resolve-products.ts`'s produktová karta v
  e-maile "alternatívy k nedostupnému tovaru".**
- **Job nemá "spusti teraz" tlačidlo (`.claude/rules/scheduler.md`) — po
  deployi zmeny, ktorá závisí od ČERSTVÝCH dát (napr. nový stĺpec ako
  `image_url` vyššie), treba pred naživo overením spustiť RUČNE presne tú
  istú cestu, akú beží nočný beh (03:50), priamo v kontajneri appky:**
  ```
  ssh newlevel@dev2
  docker exec forestshop-app-1 node -e "
  import('/app/apps/api/dist/db/client.js').then(async ({createDb}) => {
    const { runShopFeed } = await import('/app/apps/api/dist/modules/shop-feed/run.js');
    const { createHttpShopFeedFetcher } = await import('/app/apps/api/dist/modules/shop-feed/fetcher.js');
    const { db, pool } = createDb();
    const fetchFeed = createHttpShopFeedFetcher('https://www.forestshop.sk/google.xml');
    console.log(JSON.stringify(await runShopFeed({ db, now: new Date(), fetchFeed })));
    await pool.end();
  }).catch(e => { console.error(e); process.exit(1); });
  "
  ```
  Legitímne a nedeštruktívne — presne ten istý UPSERT ako plánovaný beh,
  len skôr. `createDb()` si `DATABASE_URL` zoberie sám z kontajnerového
  prostredia (`db/client.ts`), netreba ho zadávať.
