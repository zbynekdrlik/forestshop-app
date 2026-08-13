---
paths:
  - "apps/api/src/modules/scheduler/**"
  - "apps/api/src/db/schema-scheduler.ts"
  - "apps/api/src/http/scheduler-routes.ts"
  - "apps/web/src/schedulerApi.ts"
  - "apps/web/src/components/SchedulerSection.tsx"
  - "apps/web/src/components/SyncSection.tsx"
  - "apps/web/src/syncStatus.ts"
---

# Plánovač úloh (F2)

- **Pridanie ŠTVRTEJ naplánovanej úlohy = jedna nová `ScheduledJob` v
  `modules/scheduler/jobs.ts` + jeden riadok v `index.ts`'s
  `startScheduler(db, [...])` zozname + jeden riadok v `apps/web/src/
  schedulerLabels.ts`'s `JOB_LABELS`.** Tretí krok sa oddeľuje ĽAHKO —
  žiadny typecheck/build ho nevynúti (mapa má fallback na surový
  `jobName`), takže appka bez neho ticho ukazuje technický názov namiesto
  slovenského popisu v "Plánovač"/"Sync zo Shoptetu"'s histórii behov.
  Stalo sa to UŽ DVAKRÁT (issue 185 pre štyri joby naraz, issue 387 pre
  `pairing-search`) — pri KAŽDOM ďalšom novom jobe (naplánovanom AJ
  čisto manuálnom "Spustiť teraz") skontroluj `JOB_LABELS` HNEĎ vedľa
  týchto dvoch krokov, nie až keď si niekto všimne surový názov na
  obrazovke. Job's `run(db, now)` MUSÍ volať
  existujúcu, už otestovanú business-logickú funkciu (rovnaký vzor ako
  `catalogImportJob`/`pruneRawExportsJob`/`sessionCleanupJob`) — scheduler
  sám žiadnu doménovú logiku nemá a nemá ju ani získať. `run()` nikdy
  nezachytáva vlastné výnimky — necháva ich prejsť, `scheduler.ts`'s
  `executeJob` ich odchytí a zapíše ako `job_run.status = "failure"`.
- **Rozvrh je diskriminovaná únia `Schedule = DailySchedule | HourlySchedule`
  (`kind: "daily" | "hourly"`, `types.ts`), žiadny cron výraz.** `isDue()`
  (`scheduler.ts`) je čistá funkcia — periodizuje podľa `kind`. **`daily`:
  MIESTNY (Europe/Bratislava) kalendárny deň + miestna hodina/minúta (issue
  293 — predtým doslovné UTC, appka aj kontajner bežali bez nastaveného
  pásma, takže úloha nastavená na 7:00 reálne behala až o 9:00/8:00
  slovenského času; `hourUtc`/`minuteUtc` sú odvtedy premenované na
  `hourLocal`/`minuteLocal`, aby meno sedelo s tým, ako sa hodnota
  interpretuje).** `hourly`: ZOSTÁVA podľa UTC dňa+hodiny (#115), ZÁMERNE
  nelokalizované — hodinový job nemá cieľovú hodinu (beží každú hodinu),
  lokalizácia by v deň prechodu na zimný čas (opakovaná miestna hodina
  02:00-03:00) spôsobila falošné preskočenie skutočného behu; minúta v
  rámci hodiny je pre tento časový pás (vždy celohodinový offset) rovnaká v
  UTC aj v miestnom čase, netreba ju prepočítavať. Nová `daily` úloha
  dostáva vlastný `{ kind: "daily", hourLocal, minuteLocal }` (SLOVENSKÝ
  čas, nie UTC); zvoľ ho aspoň 15 min od existujúcich `daily` úloh, aby sa
  neprekrývali zbytočne (nie je to tvrdá závislosť, len aby operátor v
  logoch/`job_run` vedel odlíšiť poradie). Nová `hourly` úloha dostáva
  `{ kind: "hourly", minuteUtc }` — nemá `hourLocal`/`hourUtc`,
  beží v KAŽDEJ UTC hodine. Dnes zaregistrované: **:20 KAŽDÚ hodinu import
  katalógu** (`catalogImportJob`, `hourly` od issue 184, pôvodne `daily`
  01:00 — zmerané trvanie behu 19.5-22.9 s, zanedbateľné), 01:15 mazanie
  surových exportov katalógu (`daily`, retencia skrátená z 30 na 14 dní v
  issue 184 — hodinový import produkuje viac snapshotov, box je na 98 %
  disku), 01:30 mazanie relácií (`daily`), :45 KAŽDÚ hodinu import
  objednávok (`ordersImportJob`, `hourly` od #115, pôvodne `daily` #22),
  02:10 mazanie surových exportov objednávok (`pruneRawOrdersJob`, `daily`,
  #28 — NIE 02:00, pozri poznámku o jarnom prechode nižšie), :50 KAŽDÚ
  hodinu spätný zápis odkazov na dodávateľa do Shoptetu
  (`shoptetWritebackJob`, `hourly`, issue 122 — mimo kolízie s `:45`), :55
  KAŽDÚ hodinu spätný zápis poznámky objednávky do Shoptetu
  (`orderNoteWritebackJob`, `hourly`, issue 123 — mimo kolízie s `:45`/`:50`).
  `:20` (katalóg) je zámerne aspoň 25 min od každého suseda (25 min k
  `:45`/`:55` predošlej hodiny, 30 min k `:50`). Pridanie ďalšieho `kind` (napr.
  "weekly") by znamenalo rozšíriť `periodKey()` (`scheduler.ts`) o ďalšiu
  vetvu — rovnaký vzor ako `hourly`.
- **Nová `daily` úloha sa NIKDY nesmie naplánovať PRESNE na jarný prechod na
  letný čas v Europe/Bratislava — miestne `hourLocal: 2, minuteLocal: 0`
  (posledná marcová nedeľa) je okamih, keď 02:00 v tú noc VÔBEC
  NEEXISTUJE (hodiny skočia z 01:59 rovno na 03:00).** Nie je to bug — job
  sa spustí korektne hneď, ako miestny čas dosiahne 03:00 (`isDue()`) — ale
  ten JEDEN deň v roku beh ticho omešká asi o hodinu, bez akéhokoľvek
  signálu operátorovi. Zistené code review na issue 293 (`pruneRawOrdersJob`
  bolo pôvodne presne na `hourLocal: 2, minuteLocal: 0`) — fix bol posunúť
  minútu mimo hranice (`minuteLocal: 10`), nie hodinu. Pri KAŽDEJ ďalšej
  `daily` úlohe naplánovanej na 02:00-02:59 (alebo na hraničný čas v inom
  pásme, ak appka niekedy pridá druhé pásmo): vyhni sa `minuteLocal: 0`
  presne na tejto hodine, alebo zvoľ inú hodinu úplne.
- **Job NEPOTREBUJE vlastný advisory zámok, keď buď (a) volaná business
  funkcia už berie svoj vlastný vnútri seba** (`catalogImportJob`/
  `ordersImportJob` → `ingestCatalog`/`ingestOrders`), **alebo (b) sa vôbec
  nedotýka databázy** (`pruneRawOrdersJob` → čisto súborová `pruneRawOrders`,
  #28) — `tick()`'s `SCHEDULER_ADVISORY_LOCK_KEY` už serializuje samotné
  vloženie "running" riadku, viac netreba.
- **Nová advisory zámok kľúč VŽDY over proti existujúcim, nikdy nehádaj.**
  `pg_advisory_lock`/`pg_advisory_xact_lock` zdieľajú JEDEN priestor kľúčov
  bez ohľadu na funkciu (rovnaké upozornenie ako `testing.md`). Dnes
  obsadené: `787_878_001` (`INGEST_ADVISORY_LOCK_KEY`, `catalog/ingest.ts`),
  `787_878_002` (`SCHEDULER_ADVISORY_LOCK_KEY`, `scheduler.ts`),
  `787_878_003` (`INGEST_ORDERS_ADVISORY_LOCK_KEY`, `orders/ingest.ts`, #21),
  `787_878_100` (`TEST_DB_ISOLATION_LOCK_KEY`, `tests/helpers/db.ts`),
  `787_878_101` (`TEST_RUN_NOW_LOCK_KEY`, `tests/run-now.integration.test.ts`,
  issue 413 — vlastný testovací kľúč pre `startRunNow`u priame testy, mimo
  produkčného rozsahu presne ako `787_878_100`),
  `787_878_004` (`POSTA_UNCOLLECTED_RUN_LOCK_KEY`, `posta-uncollected/run.ts`,
  issue 172 — pozri nižšie), `787_878_005` (`ORDER_REMINDER_RUN_LOCK_KEY`,
  `order-reminder/constants.ts`, issue 173), `787_878_006`
  (`NEDOSTUPNE_SEND_LOCK_KEY`, `nedostupne/constants.ts`, issue 176 —
  serializuje jedno odoslanie, tento modul nemá naplánovaný beh),
  `787_878_007` (`SUPPLIER_STOCK_RUN_LOCK_KEY`, `supplier-stock/constants.ts`,
  issue 212), `787_878_008` (`RESTOCK_RUN_LOCK_KEY`, `restock/constants.ts`,
  issue 213), `787_878_009` (`PAIRING_SEARCH_RUN_LOCK_KEY`,
  `pairing-search/constants.ts`, issue 387 E3 — **tento zoznam bol PRED
  touto opravou zastaraný a nezahŕňal `007`/`008` vôbec** — E3's návrh aj
  zadanie preto omylom menovali `007` ako "voľný", hoci už mesiace patril
  `supplier-stock`u; review na E3 to našlo predtým, než sa dostalo do
  produkcie. Over TOTO CELÉ znenie (nielen posledné číslo) pred pridaním
  ĎALŠIEHO kľúča — zastaraný zoznam je presne to, čo spôsobilo túto
  kolíziu).
  `ordersImportJob`/`pruneRawOrdersJob` (#22/#28) nepridali žiadny nový kľúč
  (pozri bod vyššie). `shoptetWritebackJob` (issue 122) tiež žiadny nepridal
  — v tomto tickete niet manuálneho HTTP triggeru na tú istú prácu (na
  rozdiel od `catalogImportJob`/`ordersImportJob`, ktoré preto majú svoj
  vlastný zámok VNÚTRI `ingestCatalog`/`ingestOrders`), takže scheduler
  tick()'s vlastný zámok (bod nižšie) stačí.
- **`postaUncollectedJob` (issue 172) MÁ manuálny HTTP trigger ("Spustiť
  teraz") na TÚ ISTÚ prácu ako naplánovaný denný beh — presne ako
  `catalogImportJob`/`ordersImportJob`, dostáva preto VLASTNÝ zámok VNÚTRI
  `runPostaUncollected` (`POSTA_UNCOLLECTED_RUN_LOCK_KEY`).** Na rozdiel od
  tamtých dvoch je to `pg_advisory_lock` (session-scoped, na vlastnom
  vyhradenom pripojení z poolu, `db.$client.connect()`) — nie
  `pg_advisory_xact_lock` v transakcii: beh robí desiatky sekvenčných
  sieťových volaní na posta.sk (per zásielka), a držať jednu DB transakciu
  otvorenú počas nich by zbytočne zaťažovalo connection pool. Bez tohto
  zámku by dva prekrývajúce sa behy (dvaja manažéri klikli "Spustiť teraz"
  súčasne, alebo ručný klik sa prekryl s 09:00 Europe/Bratislava naplánovaným
  behom) mohli OBA prečítať ten istý predošlý `notifyCount` pred zápisom a poslať
  DUPLICITNÝ eskalačný e-mail zákazníkovi (review na PR 177 — nájdené pred
  mergom, nie testom).
- **`tick()`'s zámok chráni LEN kontrolu splatnosti + vloženie "running"
  riadku, NIE celý beh úlohy.** `job.run()` beží AŽ PO commite transakcie so
  zámkom, mimo neho — dlho bežiaci job (napr. 54 MB import katalógu) tak
  zámok nedrží počas celého behu. Splatnosť sa odvodzuje VÝLUČNE z
  perzistovaného `job_run` (posledný riadok danej úlohy podľa
  `started_at`), nikdy z pamäte procesu — to je čo robí scheduler odolný
  voči reštartu kontajnera aj druhej replike appky bez akejkoľvek
  distribuovanej koordinácie navyše.
- **`job_run` musí byť v TRUNCATE zozname oboch test-setup miest** —
  `apps/api/tests/helpers/db.ts` (integration testy) AJ
  `scripts/e2e-setup.ts` (e2e) — inak sa staré riadky naťahujú medzi behmi
  (žiadny FK problém, tabuľka na nič neukazuje, len poradie v TRUNCATE
  zozname je nutné udržiavať ručne).
- **Typ zdieľaný medzi `http/` a `modules/scheduler/` patrí do `modules/`,
  nikdy do `http/`.** `RunIngest` pôvodne žil v `http/catalog-routes.ts`;
  `modules/scheduler/jobs.ts` ho potrebovalo tiež, čo by vytvorilo
  `modules → http` závislosť opačným smerom, než je v repe bežné (`http`
  závisí od `modules`, nikdy naopak). Presunuté do `modules/catalog/
  ingest.ts` vedľa `CatalogIngestResult`, `catalog-routes.ts` ho odtiaľ
  len re-exportuje. Rovnaký test pri KAŽDOM ďalšom type zdieľanom medzi
  vrstvami: ktorá vrstva ho logicky vlastní?
- **"Spustiť teraz" (manuálny HTTP trigger) je od issue 413 ASYNC pre
  VŠETKÝCH šesť automatizácií s `job_run`-based stavom** (`shop-sitemap`,
  `pairing-search`, `posta-uncollected`, `order-reminder`, `supplier-stock`,
  `restock`) — **PRED touto zmenou bol synchrónny, zámerne a zdokumentovane
  (issue 387's "appka NEMÁ v sebe žiadny background/fire-and-forget vzor
  pre run-now"), kým prvý ostrý ~72-min beh (`supplier-stock`) a opakovaný
  ~21-min beh (`pairing-search`) neukázali, že Cloudflare tunel's ~100s
  proxy timeout (`.claude/rules/deploy.md`) spôsobuje klientsky HTTP 524 +
  ZOPAKOVANÝ POST od klienta/proxy — a druhý pokus predtým ČAKAL (blokujúci
  `pg_advisory_lock` vnútri `runXxx()`) na uvoľnenie zámku prvým behom a
  POTOM spustil DRUHÝ, úplne zbytočný beh** (naživo pozorované na
  shop-sitemap, issue 402: 08:55 aj 09:01 v ten istý deň). **Nový vzor
  (`modules/scheduler/run-now.ts`'s `startRunNow`, zdieľaný naprieč
  všetkými šiestimi):** `pg_try_advisory_lock` (NEBLOKUJÚCI) — keď zámok
  drží niekto iný, HNEĎ 200 `{error: "Beh už prebieha…"}` (nikdy 4xx/5xx,
  `.claude/rules/testing.md`'s "bežný doménový výsledok" disciplína) BEZ
  vloženia `job_run` riadku a BEZ volania `run()`; keď zámok získa, vloží
  "running" riadok, vráti 202 `{ok:true, started:true}` HNEĎ a `run()`
  spustí BEZ `await`-u v HTTP handleri (fire-and-forget) — zámok DRŽÍ PO
  CELÝ ČAS behu (nie peek-a-pusti), takže `run()` MUSÍ byť "odomknutý"
  jadrový variant (`runXxxLocked`, teraz `export`-nutý zo všetkých šiestich
  `run.ts` súborov) — inak by si vnútri seba skúsil vziať TEN ISTÝ zámok
  znova (na inom pripojení) a deadlockol by proti `startRunNow`, čo ho už
  drží. NAPLÁNOVANÝ beh (`scheduler/jobs.ts` cez `index.ts`) POUŽÍVA
  NEZMENENÝ pôvodný `runXxx()` export (vlastný zámok dnu) — scheduler↔
  run-now serializácia (druhý sa ČAKAJÚCO zaradí) ostáva pre TÚTO cestu
  úplne nedotknutá. Frontend (4 zo 6 majú tlačidlo — `pairing-search`/
  `shop-sitemap` nemajú vlastné UI) prestal čítať výsledok priamo z POST
  odpovede a namiesto toho volá zdieľaný `apps/web/src/pollJobRun.ts`'s
  `pollUntilJobDone` (opakovaný `fetchXxxStatus()`, kým `lastRun.status
  === "running"`, ohraničené ~2 min) — presne rovnaký DRY dôvod ako
  `useLoadMore.ts` (issue 337). **Ďalšia budúca automatizácia s manuálnym
  HTTP run-now triggerom** (nová `{X}_RUN_LOCK_KEY` + `job_run` vzor) MÁ
  ísť ROVNO cez `startRunNow` (export-ni `runXxxLocked`, volaj `startRunNow`
  z routes súboru) — nikdy nekopíruj pôvodný pred-413 `runAndRecord` vzor,
  ten je odstránený zo všetkých šiestich `http/*-routes.ts` súborov.
- **Osirotené `job_run` riadky (appka reštart/deploy zabije rozbehnutý beh,
  `status='running'` ostane navždy — issue 413, nález b) sa čistia
  `modules/scheduler/startup-cleanup.ts`'s `cleanOrphanedJobRuns`, volanou
  RAZ z `index.ts` HNEĎ PO migráciách, PRED `createApp`/`startScheduler`/
  `serve()`.** `UPDATE job_run SET status='failure' WHERE status='running'
  AND started_at < <čas štartu procesu>` — appka beží vždy ako PRESNE JEDNA
  inštancia (`.claude/rules/database.md`), takže "running" riadok STARŠÍ
  než štart TOHOTO procesu patrí nevyhnutne MŔTVEMU procesu; poradie v
  `index.ts` (cleanup PRED čímkoľvek, čo by mohlo vložiť NOVÝ riadok)
  garantuje nulový race. Platí VŠEOBECNE pre KAŽDÝ job (plánovaný aj
  run-now), nielen tých šesť s manuálnym HTTP triggerom.
