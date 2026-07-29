---
paths:
  - "apps/api/src/modules/orders/**"
  - "apps/api/src/cli/orders-ingest.ts"
  - "scripts/orders-ingest.ts"
---

# Objednávky zo Shoptetu (F3, #21)

- **Export je JEDEN riadok NA POLOŽKU OBJEDNÁVKY, nie na objednávku.**
  Order-level polia (`code`, `date`, `billFullName`, …) sa OPAKUJÚ na
  každom riadku tej istej objednávky — importer si preto vezme prvý
  výskyt na objednávku (`ingest.ts`'s `orderInfo` mapa), nie posledný ani
  všetky naraz.
- **`itemCode` nie je vždy skutočný produkt.** Shoptet doň zapisuje aj
  pseudo-položky objednávky — dopravu (`SHIPPING*`), platbu (`BILLING*`),
  zľavu (`DISCOUNT`), zistené naživo 2026-07-29. `parser.ts`'s
  `PSEUDO_ITEM_CODE_RE` ich prefixovo odfiltruje (case-insensitive) PRED
  akýmkoľvek DB dopytom — bez toho by FK na `variant.code` zhodilo celú
  transakciu na prvej takej položke.
- **Ten istý produkt sa v tej istej objednávke niekedy objaví na DVOCH
  riadkoch** (napr. rozdelené množstvo pri úprave objednávky). `ingest.ts`
  ich zoskupí podľa (`externalOrderId`, `variantCode`) a množstvo SČÍTA —
  preto `order_line` má unikátny index `(order_id, variant_code)`
  (migrácia `0007_groovy_alice.sql`), ktorý #20 nemal (nebol preň ešte
  dôvod).
- **`itemCode`, ktorý prejde pseudo-filtrom, ešte nemusí byť ZNÁMY
  variant** (dávno vypnutý/premenovaný produkt). Autorita je AŽ dávkový
  `SELECT code IN (...)` proti `variant` v `ingest.ts` — neznámy sa
  preskočí + zaloguje (`skippedItemCount`), nikdy nezhodí import.
- **`date` nenesie časovú zónu — je to miestny čas Europe/Bratislava.**
  `parser.ts`'s `parseShopLocalDateTime` prevádza na UTC cez
  `Intl.DateTimeFormat` (guess-format-diff trik), NIE pevný offset
  (+1/+2) — pevný offset by pri prechode na/z letného času (posledná
  marcová/októbrová nedeľa) ticho posunul objednávky o hodinu. Testy
  pokrývajú explicitne letný (CEST) aj zimný (CET) dátum.
- **`dateFrom`/`dateUntil` čakajú `YYYY-M-D`, BEZ nuly na začiatku mesiaca/
  dňa** (overené `curl` proti reálnemu exportu) — `fetcher.ts`'s
  `formatDateParam` používa UTC gettery (nie lokálne), aby formátovanie
  nezáviselo od časovej zóny hostiteľa. Sú to obyčajné dátumy, nie
  tajomstvo — pridané do `redactUrl`'s allowlistu vedľa `patternId`/
  `partnerId`, inak by prekrytie skrylo presne to okno, ktoré operátor
  potrebuje vidieť pri ladení.
- **`order.comment` a `order_line.state` sú vlastníctvo manažéra/appky,
  NIKDY zo Shoptetu** — `ingest.ts`'s `onConflictDoUpdate` ich zámerne
  VYNECHÁVA zo `set`. Re-import smie osviežiť `customerName`/`placedAt`/
  `quantity`, nikdy nevrátiť rozpracovaný riadok naspäť na `objednane`
  ani vymazať manažérov komentár.
- **Objednávky nemajú snapshotovú tabuľku ako katalóg (zámerne)** — brána
  prijatia preto NEPOROVNÁVA proti "poslednému prijatému", ale proti tomu,
  čo je UŽ v databáze pre TO ISTÉ `placedAt` okno (dopyt v `ingest.ts`,
  po `pg_advisory_xact_lock`, presne ako katalógov `previousAccepted`).
  Pomer `previousLineRatio = 0.2` je zámerne benevolentnejší než
  katalógových 0.8 — objem objednávok kolíše oveľa viac deň-na-deň
  (víkendy, sezónnosť) než počet produktov v katalógu.
- **Advisory zámok kľúč `787_878_003`** (`INGEST_ORDERS_ADVISORY_LOCK_KEY`)
  — ďalší v registri `.claude/rules/scheduler.md`, nikdy nehádaj nový.
- **Žiadna HTTP trasa ani plánovač zatiaľ neexistuje** (#22/#23 sú
  samostatné tickety) — jediný spôsob, ako import spustiť, je
  `pnpm orders:ingest` (lokálne/CI) alebo `node apps/api/dist/cli/
  orders-ingest.js` (produkcia, rovnaký vzor ako `catalog-prune-raw`,
  pozri `.claude/rules/deploy.md`) — `SHOPTET_ORDERS_URL`/`DATABASE_URL`
  musia byť nastavené v prostredí.
- **Fixtúra (`fixtures/orders-sample.csv`) je ručne vyrobená z reálnej
  67-stĺpcovej hlavičky** (nie výrez reálneho exportu ako katalóg — export
  objednávok nesie mená a e-maily zákazníkov, tie sa nekomitujú), cp1250
  cez `iconv -f utf-8 -t windows-1250`. Obsahuje zámerne: duplicitný riadok
  rovnakého produktu (sčítanie), pseudo-položku (`SHIPPING6`), neznámy
  variant (`99999/ZZ`), prázdny `itemCode` — pokrýva všetky preskočené
  triedy naraz.
