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
  `startScheduler(db, [...])` zozname.** Job's `run(db, now)` MUSÍ volať
  existujúcu, už otestovanú business-logickú funkciu (rovnaký vzor ako
  `catalogImportJob`/`pruneRawExportsJob`/`sessionCleanupJob`) — scheduler
  sám žiadnu doménovú logiku nemá a nemá ju ani získať. `run()` nikdy
  nezachytáva vlastné výnimky — necháva ich prejsť, `scheduler.ts`'s
  `executeJob` ich odchytí a zapíše ako `job_run.status = "failure"`.
- **Rozvrh je diskriminovaná únia `Schedule = DailySchedule | HourlySchedule`
  (`kind: "daily" | "hourly"`, `types.ts`), žiadny cron výraz.** `isDue()`
  (`scheduler.ts`) je čistá funkcia — periodizuje podľa `kind` (`daily`: UTC
  kalendárny deň, `hourly`: UTC deň+hodina, #115). Nová `daily` úloha dostáva
  vlastný `{ kind: "daily", hourUtc, minuteUtc }`; zvoľ ho aspoň 15 min od
  existujúcich `daily` úloh, aby sa neprekrývali zbytočne (nie je to tvrdá
  závislosť, len aby operátor v logoch/`job_run` vedel odlíšiť poradie). Nová
  `hourly` úloha dostáva `{ kind: "hourly", minuteUtc }` — nemá `hourUtc`,
  beží v KAŽDEJ UTC hodine. Dnes zaregistrované: 01:00 import katalógu
  (`daily`), 01:15 mazanie surových exportov katalógu (`daily`), 01:30
  mazanie relácií (`daily`), :45 KAŽDÚ hodinu import objednávok
  (`ordersImportJob`, `hourly` od #115, pôvodne `daily` #22), 02:00 mazanie
  surových exportov objednávok (`pruneRawOrdersJob`, `daily`, #28), :50
  KAŽDÚ hodinu spätný zápis odkazov na dodávateľa do Shoptetu
  (`shoptetWritebackJob`, `hourly`, issue 122 — mimo kolízie s `:45`).
  Pridanie ďalšieho `kind` (napr. "weekly") by znamenalo rozšíriť
  `periodKey()` (`scheduler.ts`) o ďalšiu vetvu — rovnaký vzor ako `hourly`.
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
  `787_878_004` (`POSTA_UNCOLLECTED_RUN_LOCK_KEY`, `posta-uncollected/run.ts`,
  issue 172 — pozri nižšie), `787_878_005` (`ORDER_REMINDER_RUN_LOCK_KEY`,
  `order-reminder/constants.ts`, issue 173), `787_878_006`
  (`NEDOSTUPNE_SEND_LOCK_KEY`, `nedostupne/constants.ts`, issue 176 —
  serializuje jedno odoslanie, tento modul nemá naplánovaný beh).
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
  súčasne, alebo ručný klik sa prekryl s 07:00 UTC naplánovaným behom) mohli
  OBA prečítať ten istý predošlý `notifyCount` pred zápisom a poslať
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
