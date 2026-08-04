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
- **Rozoberač je zámerne regulárny výraz bez novej závislosti na XML parseri.**
  Tvar feedu je plochý (`<entry>` s textovými deťmi). Hlavička feedu má
  `<link href="…" />` s adresou vzorového webu — preto vzor hľadá `<link>` s
  KONCOVOU značkou, inak by sa do mapy dostal `example.com`.
- **`MIN_ENTRIES` je poistka proti tichému vyprázdneniu mapy.** Keď feed vráti
  menej než 1 000 použiteľných položiek, beh vyhodí a do tabuľky NEZAPÍŠE —
  inak by jeden pokazený beh zmazal adresy a odkazy by sa ticho vrátili na
  vyhľadávanie. Riadky, ktoré feed už neobsahuje, sa zámerne NEMAŽÚ: stará
  platná adresa je lepšia než žiadna.
