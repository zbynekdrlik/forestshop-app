---
paths:
  - "apps/api/src/modules/scheduler/**"
  - "apps/api/src/db/schema-scheduler.ts"
  - "apps/api/src/http/scheduler-routes.ts"
  - "apps/web/src/schedulerApi.ts"
  - "apps/web/src/components/SchedulerSection.tsx"
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
- **Rozvrh je len denná hodina:minúta v UTC (`DailySchedule`), žiadny cron
  výraz.** `isDue()` (`scheduler.ts`) je čistá funkcia — nová úloha dostáva
  vlastný `{ hourUtc, minuteUtc }`; zvoľ ho aspoň 15 min od existujúcich
  troch (01:00 import, 01:15 prune, 01:30 session-cleanup), aby sa
  neprekrývali zbytočne (nie je to tvrdá závislosť, len aby operátor v
  logoch/`job_run` vedel odlíšiť poradie).
- **Nová advisory zámok kľúč VŽDY over proti existujúcim, nikdy nehádaj.**
  `pg_advisory_lock`/`pg_advisory_xact_lock` zdieľajú JEDEN priestor kľúčov
  bez ohľadu na funkciu (rovnaké upozornenie ako `testing.md`). Dnes
  obsadené: `787_878_001` (`INGEST_ADVISORY_LOCK_KEY`, `ingest.ts`),
  `787_878_002` (`SCHEDULER_ADVISORY_LOCK_KEY`, `scheduler.ts`),
  `787_878_100` (`TEST_DB_ISOLATION_LOCK_KEY`, `tests/helpers/db.ts`).
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
