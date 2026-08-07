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
  "Spustiť teraz" súčasne, alebo ručný klik prekrývajúci sa s 09:00
  Europe/Bratislava scheduled behom — issue 293: predtým sa `hourLocal: 7`
  interpretoval doslovne ako 7:00 UTC, čo bolo 09:00 slovenského letného
  času a bol to zámer odjakživa; oprava časového pásma literál nechala
  nedotknutý, takže nasledujúci tiket ho vrátil na 9, aby cieľový čas
  09:00 Europe/Bratislava zostal zachovaný) mohli OBA prečítať
  ten istý `notifyCount` pred zápisom a
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
- **Issue 268 zapojilo TENTO existujúci denný beh do nástenky Upozornenia
  (#267) — `runPostaUncollectedLocked` volá `upsertUpozornenie`/
  `autoResolveByDedupKey` (`.claude/rules/upozornenia.md`) PRIAMO, žiadny
  nový poller/job.** Karta sa píše presne tam, kde `cls.uncollected` už
  napĺňa `uncollected` pole výsledku; zatvára sa presne tam, kde
  `terminalState(trackingJson) !== ""` (pred `continue`). `dedupKey` je
  `posta:<packageNumber>` (`logic.ts`'s `postaUpozornenieDedupKey`) — JEDEN
  zdieľaný helper pre OBE volania, aby zápis a zatvorenie nikdy nedostali
  rôzny formát kľúča. **Oprava medzery (issue 275, pôvodne nájdenej code
  review-om na #268):** vetva `cls.status === "invalid_format"` predtým
  nerobila ani jedno z toho — karta vytvorená pri predošlom "notified" behu
  ostávala navždy otvorená, keď tracking neskôr začal vracať neparsovateľný
  formát, bez akéhokoľvek signálu pre majiteľa. Fix je TRETIA funkcia,
  `updateIfUnresolvedByDedupKey` (`upozornenia/service.ts`) — na rozdiel od
  `upsertUpozornenie` (create-or-refresh) a `autoResolveByDedupKey` (close),
  táto je čisté UPDATE-if-exists: keď pre `dedupKey` existuje nevyriešená
  karta, jej titulok/podrobnosti sa prepíšu na "sledovanie zlyhalo, over
  ručne", ale `resolvedAt` sa nedotýka (karta ostáva otvorená — auto-
  zatvorenie by mohlo skryť reálny, ešte nevyriešený problém) A NIKDY sa
  nevytvorí NOVÁ karta (zásielka, čo nikdy predtým nebola nahlásená ako
  nevyzdvihnutá, nepotrebuje kartu len kvôli jednorazovému zlyhaniu
  trackingu — to by bol zbytočný šum). Pri KAŽDOM ĎALŠOM novom stave/vetve
  pridanom do tejto funkcie over, či nepotrebuje TIEŽ napojenie na
  write/auto-resolve/update-in-place cestu — a ak ide o zdroj, čo môže
  STRATIŤ SCHOPNOSŤ rozhodnúť (nie o skutočnú zmenu stavu), zváž
  `updateIfUnresolvedByDedupKey`, nie automatické zatvorenie.
- **Issue 298 (šéf, cez majiteľa): karta na Upozorneniach preklikáva PRIAMO
  na sledovanie zásielky na Pošte SK (`trackingLink`, `constants.ts` — ten
  istý helper, aký "Nevyzdvihnuté zásielky"'s výsledková tabuľka už používa,
  `PostaUncollectedRow.tsx`), NIE na Shoptet admin objednávku (predošlé
  správanie).** `run.ts`'s `upsertUpozornenie` volanie: `link:
  trackingLink(packageNumber)` namiesto `adminOrderUrl(shipment)` — číslo
  objednávky ostáva čitateľné v TITULKU karty, len prestalo byť samotným
  klikateľným odkazom (appka nemá druhé pole na "druhý odkaz", `link` je
  JEDEN stĺpec). `details` NAVYŠE pridáva `Vyzdvihnutie do: <dátum>` riadok
  KEĎ `cls.retainedTill` nie je prázdne (rovnaká hodnota, akú `classifyTracking`
  UŽ vypočítal pre e-mailovú šablónu — žiadne nové sieťové volanie); keď
  Pošta SK termín nevráti, riadok sa VYNECHÁ celý (nie prázdny "Vyzdvihnutie
  do: "). **Zisťovanie o "preklik do vyfiltrovaného zoznamu oznámených
  zásielok" (šéfova druhá časť žiadosti):** Pošta SK nemá zdokumentovaný/
  potvrdený verejný filtrovaný-zoznam URL formát — appka pozná len (a) tento
  per-zásielkový `trackingLink` (`https://www.posta.sk/sledovanie-zasielok#parcel=<číslo>`)
  a (b) samotné `TRACKING_API_URL_TEMPLATE` (JSON API, nie stránka pre
  človeka). Kým sa nenájde/nepotvrdí live taký zoznamový odkaz, appka
  odkazuje LEN na konkrétnu zásielku — nevymýšľaj URL vzor, ktorý nebol
  overený naživo (`.claude/rules/investigate-existing-first.md`'s princíp).
- **LINK_LABELS (`UpozornenieCard.tsx`) pre `nevyzdvihnuta_zasielka` je
  odteraz "Sledovať zásielku na Pošte" (predtým "Otvoriť objednávku v
  Shoptete", zdieľané s `vratenie` — tá si svoj pôvodný štítok zachováva).**
  **Pokus o E2E fixtúru bol ZAMIETNUTÝ, poučenie pre budúce podobné
  prípady:** predbežná verzia issue 298 pridala do `scripts/e2e-setup.ts`
  jednu PEVNE seedovanú `upozornenie` kartu (UŽ odloženú, aby sa vyhla
  predvolenej "Otvorené" záložke) — ale `upozornenie` je GLOBÁLNA, nie
  per-užívateľská tabuľka, takže akýkoľvek trvalo seedovaný riadok mení
  VÝSLEDOK `classifyEmptyMessage`'s doplnkového dopytu (`includeResolved:
  true, includePostponed: true`) pre KAŽDÝ účet vrátane samotného
  `upozornenia.spec.ts`'s — živo spadlo na jeho ÚPLNE PRVEJ asercii
  ("Žiadne upozornenia — nič nie je zapísané." sa zmenilo na "…— všetko je
  odložené.", presne to gap-3 regresné overenie z issue 267 follow-up).
  Riešenie NIE je zmeniť tú asserciu (zmenilo by zmysel testu, čo overuje
  "naozaj nič nie je zapísané") — namiesto toho karta zostáva pokrytá
  VÝHRADNE (a) integračným testom obsahu/linky
  (`posta-uncollected-run.integration.test.ts`) a (b) vitest komponentovým
  testom rendrovania štítku (`UpozorneniaSection.test.tsx`'s
  `NEVYZDVIHNUTA_KARTA` fixtúra — rovnaký vzor ako existujúci `VRATENIE_KARTA`
  link test). **Test pre KAŽDÚ ĎALŠIU myšlienku "seedni fixnú kartu do
  `upozornenie` v `e2e-setup.ts`":** táto tabuľka je zdieľaná GLOBÁLNE
  naprieč VŠETKÝMI e2e účtami/spec súbormi — akýkoľvek trvalý riadok mení
  `classifyEmptyMessage`'s výsledok pre každého; over najprv, či niektorý
  INÝ spec súbor (najmä `upozornenia.spec.ts` samo) nespolieha na skutočne
  prázdnu tabuľku, než pridáš seed.
