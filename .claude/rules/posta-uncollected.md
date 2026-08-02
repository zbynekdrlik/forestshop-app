---
paths:
  - "apps/api/src/modules/posta-uncollected/**"
  - "apps/api/src/http/posta-uncollected-routes.ts"
  - "apps/web/src/components/PostaUncollected*.tsx"
  - "apps/web/src/postaUncollectedApi.ts"
---

# Nevyzdvihnuté zásielky (Pošta SK, issue 172)

- **`enabled` (Štart/Stop, `posta_uncollected_settings`) gate-uje LEN
  naplánovaný denný beh** (`scheduler/jobs.ts`'s `postaUncollectedJob`
  skontroluje flag PRED volaním). **"Spustiť teraz" (HTTP `/run-now`) volá
  `runPostaUncollected` PRIAMO, vždy, bez ohľadu na tento flag** — presne
  ako stará appka's `AutomationRunner.run_now` ("runs even when disabled —
  an explicit manager action"). Skutočná bezpečnostná poistka pre OBIDVE
  cesty je `bccEmail`/`mailTransport` fail-closed kontrola VNÚTRI
  `run.ts` — tá jediná rozhoduje, či sa reálne pošle mail, nikdy `enabled`.
  Ďalšia automatizácia s rovnakým manuálnym-triggerom-popri-scheduli tvarom
  (napr. budúce "pripomienky objednávok", issue 173/176) potrebuje ROVNAKÚ
  úvahu — nedávaj `enabled` kontrolu do business funkcie samotnej.
- **Objednávkové polia `email`/`phone`/`package_number`/
  `shipping_carrier_name` (issue 172, `orders/parser.ts`'s
  `extractOrderLevelExtra`) sa COALESCE-ujú pri re-importe, NIE prepisujú
  priamo** — rovnaký dôvod ako `shoptet_order_id` (`.claude/rules/
  orders.md`): extrahujú sa z KAŽDÉHO riadku objednávky, takže jeden
  export cyklus, kde tieto stĺpce vyjdú na VŠETKÝCH riadkoch danej
  objednávky prázdne (formátovací výpadok), by priamym prepísaním ticho
  vynuloval už zistenú hodnotu — a táto automatizácia by prestala
  sledovať tú zásielku bez akéhokoľvek varovania. Nájdené code review na
  PR 177 (nie testom) — regresný test:
  `orders-ingest-posta-fields.integration.test.ts`'s "re-import ... NEVYNULUJE".
- **`runPostaUncollected` je serializovaný `POSTA_UNCOLLECTED_RUN_LOCK_KEY`-om
  (787_878_004, `.claude/rules/scheduler.md`) — `pg_advisory_lock` na
  VLASTNOM vyhradenom pripojení (`db.$client.connect()`), nie
  `pg_advisory_xact_lock` v transakcii.** Dôvod pre session-scoped namiesto
  xact-scoped: beh robí desiatky sekvenčných sieťových volaní na posta.sk
  (per zásielka), a xact-scoped zámok by znamenal držať jednu DB transakciu
  otvorenú počas nich (zbytočná záťaž na connection pool). Nájdené code
  review na PR 177 — bez zámku by dva prekrývajúce sa behy (dvaja manažéri
  "Spustiť teraz" súčasne, alebo ručný klik prekrývajúci sa s 07:00 UTC
  scheduled behom) mohli OBA prečítať ten istý `notifyCount` pred zápisom a
  poslať duplicitný e-mail zákazníkovi. Regresný test (deterministický,
  `pg_try_advisory_lock` z druhého pripojenia — rovnaká technika ako
  `db-isolation-lock.integration.test.ts`):
  `posta-uncollected-run.integration.test.ts`'s "dva súbežné behy sa serializujú".
- **Zobrazovací stav (posledný beh, tabuľka zásielok, invalid/errors,
  coverage) ŽIJE v `job_run.detail` (jsonb) — ŽIADNA nová tabuľka navyše**,
  presne ako každý iný job. `GET /api/posta-uncollected` a preview endpoint
  čítajú `getLatestJobRun(db, POSTA_UNCOLLECTED_JOB_NAME)`, nikdy znova
  nehýtajú posta.sk. Ďalšia automatizácia s podobným "zobraz posledný
  výsledok" požiadavkom by mala použiť ten istý vzor namiesto vlastnej
  tabuľky.
- **E2E test (`posta-uncollected.spec.ts`) beží na SKUTOČNOM tracking
  klientovi (žiadny mock v `index.ts`/`app.ts` pre e2e), ale NIKDY sa
  nedotkne api.posta.sk** — `scripts/e2e-setup.ts`'s seedované objednávky
  nemajú `packageNumber` (nikde nastavený), takže `runPostaUncollected` má
  vždy `checked=0` a tracking klient sa nikdy nezavolá. Ak nejaký budúci
  e2e test PRIDÁ seedovanú objednávku s `packageNumber`, MUSÍ zároveň
  vstreknúť falošný tracking klient (rovnaký vzor ako integračné testy) —
  inak by e2e balík reálne kontaktoval tretiu stranu.
- **Post-deploy poznámka:** nové stĺpce `order.email`/`package_number`/…
  sú `null` pre KAŽDÚ existujúcu objednávku hneď po migrácii (additive
  migrácia nič nedopĺňa) — coverage poistka preto na prvý pohľad ukáže
  "100% chýba číslo zásielky" HNEĎ po nasadení, kým hodinový import
  objednávok (`ordersImportJob`, `:45`) polia neosviežia zo živého
  Shoptet exportu. Toto NIE JE bug, len prechodný stav prvej hodiny po
  nasadení — neriešiť ako regresiu, ak sa znova objaví po podobnej
  migrácii pridávajúcej nové Shoptetove polia.
