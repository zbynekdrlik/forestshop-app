---
paths:
  - "apps/api/src/modules/orders/order-flags*.ts"
  - "apps/api/src/modules/orders/return-status.ts"
  - "apps/api/src/http/order-flags-routes.ts"
  - "apps/web/src/components/ExchangeOrdersSection.tsx"
  - "apps/web/src/components/ReturnedOrdersSection.tsx"
  - "apps/web/src/components/ClaimOrdersSection.tsx"
  - "apps/web/src/components/OrderFlagTable.tsx"
  - "apps/web/src/orderFlagsApi.ts"
---

# Eshop → Výmena tovaru / Vrátený tovar / Reklamácie (order-flags, #290)

Tri READ-ONLY sekcie nad `order.status_name` (Výmena/Vrátený tovar) a nad
appkiným `order.claim_marked_at` (Reklamácie). Modul: `order-flags.ts`
(klasifikátory stavov), `order-flags-queries.ts` (výpisy + počty),
`order-flags-routes.ts` (HTTP), zdieľaný `OrderFlagTable.tsx`.

- **Výpis sekcie AJ jej menu-odznak zdieľajú JEDEN predikát + JEDNU query
  cestu.** `listExchangeOrders`/`listReturnedOrders` aj `countOrderFlags`
  idú OBA cez `selectFlaggedByStatus(db, isExchangeOrderStatus)` (resp.
  `isReturnedOrderStatus`). Zmena, ktorá má invertovať/rozšíriť „ktoré
  objednávky sekcia ukazuje", sa robí v JEDNOM klasifikátore v
  `order-flags.ts` (`EXCHANGE_STATUS`/`RETURNED_*_STATUS`) — výpis aj počet
  ju preberú automaticky, nikdy neduplikuj SQL/JS count. Issue 514 tak
  invertovalo „Výmena tovaru" jedinou zmenou `EXCHANGE_STATUS` (z „Vybavená
  výmena" na „Výmena tovaru").
- **Menu-odznaky exchange/returned/claims sú UŽ NAPOJENÉ v `App.tsx` (#290)**
  — `fetchOrderFlagCounts` → `orderFlagCounts` → `badgeCounts["exchange"/…]`,
  zobrazené LEN pri `> 0` (skryté pri 0, na rozdiel od orders/upozornenia,
  ktoré ukazujú aj 0). „Pridaj badge na Výmena/Vrátený/Reklamácie" preto
  NEvyžaduje zmenu `App.tsx`/`nav.ts` — stačí zmeniť SÉMANTIKU príslušného
  poľa v `countOrderFlags`. Badge testid je `nav-badge-<tab.id>`
  (`nav-badge-exchange` atď.), e2e ho over ako `/^[1-9]\d*$/` (nie presné
  číslo — zdieľaná seed DB, vzor #445), nikdy neasertuj jeho neprítomnosť.
- **`OrderFlagRow.unresolved` (štítok „nevybavené") = objednávka má ešte
  OTVORENÚ „vratenie" kartu na Upozorneniach** (`return-status.ts`'s
  `returnUpozornenieDedupKey`, kľúč na objednávku). Kritická doménová fakt:
  ktoré stavy vôbec zakladajú/držia kartu, hovorí `return-status.ts` —
  ACTIVE = „Vratený tovar" (zakladá/obnovuje), FINISHED = „Vybavená
  výmena"/„Vybavený Dobropis" (auto-zatvárajú). **Stav „Výmena tovaru" je v
  ANI JEDNEJ mape**, takže preň karta nikdy nevznikne → `unresolved` je preň
  prakticky vždy `false` a štítok sa v sekcii „Výmena tovaru" bežne
  nezobrazí (ostáva len pre zriedkavý prechod „Vratený tovar → Výmena
  tovaru" s lingering otvorenou kartou). Preto (issue 514) je exchange badge
  = počet VŠETKÝCH aktívnych výmen (`exchangeRows.length`), NIE
  unresolved-filtrovaný — filtrovať by ho navždy skrylo; returned ostáva
  unresolved-filtrovaný, lebo „Vratený tovar" JE aktívny vrátkový stav s
  kartami. Táto asymetria počtov je zámerná, nie bug.
- **Priradenie stavu VŽDY over naživo na produkcii, nie zo starej appky ani
  z odhadu** — issue 290 aj 514 to overili priamo v prod DB
  (`docker exec forestshop-postgres-1 psql -U forestshop -d forestshop -c
  "select status_name, count(*) from \"order\" where status_name ilike
  '%mena%' group by 1"`, iba čítanie). Realita sa mení: #290 priradilo
  „Vybavená výmena", lebo vtedy nebola žiadna „Výmena tovaru"; #514 to
  invertovalo, keď pribudli aktívne výmeny. Porovnanie beží cez
  `normalizeStatusName` (NFC + orez) na oboch stranách — rovnaká funkcia ako
  `ingest.ts` pri ukladaní `order.status_name`.
- **`unresolved` sa počíta DVOJKROKOVO bez `.for("update")`**
  (`unresolvedDedupKeySet`): najprv objednávky filtrom, potom otvorené
  „vratenie" karty pre ich dedup kľúče. Čisté čítanie, žiadny zápis do
  `upozornenie` (to ostáva výhradne `return-upozornenia.ts`/#269).
- **`unresolved` NEMÁ e2e pokrytie zámerne** — `upozornenie` je globálna
  tabuľka zdieľaná so `upozornenia.spec.ts` (seedovaná karta by zmenila jeho
  „žiadne upozornenia" prázdny stav). Logiku pokrýva
  `order-flags-http.integration.test.ts` (izolovaná DB) + komponentové
  vitest testy (mock). Nový test tejto oblasti nech drží ten istý rozdel.
