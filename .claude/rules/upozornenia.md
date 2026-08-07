---
paths:
  - "apps/api/src/modules/upozornenia/**"
  - "apps/api/src/http/upozornenia-routes.ts"
  - "apps/api/src/db/schema-upozornenia.ts"
  - "apps/web/src/upozorneniaApi.ts"
  - "apps/web/src/components/Upozornenia*.tsx"
  - "apps/web/src/components/UpozornenieCard.tsx"
  - "apps/web/tests/e2e/upozornenia.spec.ts"
---

# Upozornenia (issue 267)

- **`upsertUpozornenie()` (`modules/upozornenia/service.ts`) je JEDINÁ
  zapisovacia cesta pre NOVÉ upozornenie** — presne rovnaký princíp ako
  `.claude/rules/mail-log.md`'s "jediná odosielacia cesta". Budúci
  automatický zdroj (#268 nevyzdvihnutá zásielka, #269 vrátenie) volá TÚTO
  funkciu s vlastným `dedupKey`, nikdy vlastný `db.insert(upozornenie)`.
- **`upozornenie_dedup_key_uq` je ČIASTOČNÝ unique index
  (`WHERE resolved_at IS NULL`), nie plný.** Nájdené integračným testom PRED
  mergom (nie odhadom): bez `.where()` druhý výskyt toho istého `dedupKey`
  PO vyriešení prvého (napr. zásielka sa znova vyzdvihne a znova zastaví o
  mesiac neskôr) narazí na unique-violation namiesto vloženia nového riadku
  — `upsertUpozornenie`'s zámerné správanie je totiž "vyriešený riadok sa
  NIKDY neobnovuje, ďalší výskyt dostane VLASTNÝ nový riadok". Drizzle-orm
  (`^0.38.x`) podporuje toto cez `uniqueIndex(...).on(...).where(sql\`...\`)`
  — každý ĎALŠÍ dedup stĺpec s "kým je nevyriešené" semantikou potrebuje ten
  istý čiastočný index, nie obyčajný `uniqueIndex`.
- **Stav (nové/otvorené/odložené/vybavené) sa NEUKLADÁ — počíta sa vždy z
  troch nullable timestampov** (`seenAt`/`postponedUntil`/`resolvedAt`,
  `modules/upozornenia/status.ts`'s `computeStatus`). Zámerné: odložená
  karta sa má "v ten deň vrátiť späť" bez akejkoľvek novej naplánovanej
  úlohy (ticket to explicitne zakazuje) — počítaný stav je vždy správny pri
  čítaní, žiadny cron, čo ho má o polnoci preklopiť.
- **Odznak v ľavom menu (`countActionableUpozornenia`) MUSÍ použiť rovnaký
  predikát ako predvolený filter zoznamu** (nevyriešené A práve
  NEODLOŽENÉ) — inak číslo v menu a to, čo appka ukáže pri otvorení
  záložky, nesedia. Code review pred mergom (pôvodná verzia natiahla VŠETKY
  riadky do JS a filtrovala cez samostatnú `isActionableNow` funkciu — druhá,
  nezávisle udržiavaná implementácia tej istej podmienky, navyše zbytočný
  celý-tabuľkový sken): oprava je zdieľaná `notPostponedCondition(now)`
  (`queries.ts`), ktorú POUŽÍVA AJ `listUpozornenia`'s `WHERE`, AJ
  `countActionableUpozornenia`'s `COUNT(*) WHERE` — nikdy dve nezávislé
  implementácie tej istej podmienky (JS aj SQL), vždy JEDNA zdieľaná.
- **Odznak počtu (na rozdiel od "Na objednanie"'s `OrdersRemainingCountContext`,
  issue 147) sa číta PRIAMO v `App.tsx`** (`fetchUpozorneniaCount`, rovnaký
  vzor ako `automationStatus`/`fetchPostaUncollectedStatus`) — číslo musí
  byť známe HNEĎ po prihlásení, nie až po prvom otvorení záložky (na rozdiel
  od "Na objednanie", kde ho publikuje samotná obrazovka cez context).
- **Otvorenie záložky = "prečítané" (hromadné `POST
  /api/upozornenia/mark-seen`), nie per-kartové tlačidlo.**
  `UpozorneniaSection.tsx` volá mark-seen a AŽ POTOM `load()` — cez
  `mountedRef` guard (rovnaký vzor ako issue 251's StrictMode-bezpečný
  "mountedRef nastavený v tele efektu", `.claude/rules/frontend-design.md`),
  aby sa mark-seen spustil PRESNE RAZ za mount, nikdy znova pri zmene
  filtra "aj vybavené" (ten len refetchne `load()` bez mark-seen).
- **`updateOwnNote`/`deleteOwnNote` server-side vynucujú `source ===
  "vlastne"`** — karta zo zdroja "appka" nemá tlačidlá Upraviť/Zmazať vôbec
  vo frontende, ale to nestačí (rovnaká past ako `.claude/rules/
  nedostupne.md`'s povinný náhľad — front-end skrytie nie je vynútenie).
  Server vráti `updated`/`removed: false` namiesto chyby pri pokuse o cudziu
  kartu.
- **Odložená karta bola živo nájdená ako NEVIDITEĽNÁ ÚPLNE VŽDY — žiadna
  hodnota žiadneho filtra ju neodkryla, a neexistovala akcia na jej
  vrátenie skôr, než sa vráti sama** (issue 267 follow-up, gap 2, nájdené
  post-deploy Playwright overením na produkcii `0.3.0-dev.155`:
  `GET /api/upozornenia?includeResolved=true` vrátil `{"rows":[]}`, hoci
  riadok existoval s `postponed_until` v budúcnosti). Fix je NEZÁVISLÝ
  druhý filter `includePostponed` (mirror `includeResolved` — `queries.ts`'s
  `listUpozornenia` vynechá `notPostponedCondition` len keď je `true`) PLUS
  nová akcia `cancelPostpone`/`POST /api/upozornenia/:id/cancel-postpone`
  (nastaví `postponedUntil: null`, seenAt sa NEDOTÝKA — karta bola už
  videná v momente odloženia). **`countActionableUpozornenia` (odznak)
  túto výnimku NIKDY nedostáva** — je to len UI zobrazenie na požiadanie,
  nikdy zmena toho, čo je "akčné". Pri KAŽDOM ĎALŠOM boolean UI filtri v
  tejto appke, ktorý pridáva DRUHÚ os k existujúcemu (`includeResolved`):
  over, či osi sú naozaj ORTOGONÁLNE (karta môže byť A bez B) — ak áno,
  nezlučuj ich do jedného checkboxu, daj druhý nezávislý.
- **Prázdny zoznam tvrdil natvrdo "všetko je vybavené" bez ohľadu na
  SKUTOČNÚ príčinu — živo nájdené s jedinou odloženou (nie vybavenou)
  kartou** (issue 267 follow-up, gap 3). Fix: `classifyEmptyMessage()`
  (`UpozorneniaSection.tsx`) rozhodne podľa JEDNÉHO doplnkového najširšieho
  dopytu (`{includeResolved:true, includePostponed:true}`), spusteného LEN
  keď je aktuálny (možno užší) zoznam prázdny — nikdy pri každom `load()`.
  **Code review našiel, že tento doplnkový dopyt (presne ako HLAVNÝ
  `fetchUpozornenia` dopyt) potrebuje "latest ref" poistku proti
  zastaranej odpovedi** (`loadSeqRef`, inkrementovaný na začiatku KAŽDÉHO
  `load()` volania) — ĎALŠÍ sibling výskyt tej istej triedy race, ktorú
  `.claude/rules/frontend-design.md` dokumentuje pri issue 151/251/264.
  Akýkoľvek BUDÚCI reťazený/doplnkový fetch v tomto súbore potrebuje ten
  istý guard, nie len ten prvý v reťazci.
- **Pridanie doplnkového `fetchUpozornenia` volania, ktoré sa spúšťa
  PODMIENEČNE (len keď je zoznam prázdny), rozbije EXISTUJÚCE testy s
  pevnou `mockResolvedValueOnce().mockResolvedValueOnce()` sekvenciou** —
  ak prvé volanie vráti prázdne pole, vloží sa medzi ne NEČAKANÉ ĎALŠIE
  volanie, ktoré spotrebuje `Once` hodnotu určenú pre NESKORŠÍ (napr.
  po-mutácii) reload, a ten potom dostane `undefined` z vyčerpanej fronty
  (`TypeError` na `.then` alebo test timeout). Fix (viď `UpozorneniaSection
  .test.tsx`/`.badgeRefresh.test.tsx`): vlož TRETIE `mockResolvedValueOnce
  ([])` presne na miesto, kde sa doplnkový dopyt spustí. Test, ktorý
  namiesto sekvenčných `Once` hodnôt používa `mockImplementation` podľa
  argumentu filtra (`UpozorneniaSection.emptyMessage.test.tsx`), tomuto
  problému nepodlieha vôbec — uprednostni ten vzor, keď test musí
  rozlišovať MEDZI viacerými súbežne možnými volaniami tej istej funkcie.
- **Issue 269 (druhý automatický zdroj, vrátenie/výmena/dobropis) sa napojilo
  na import objednávok (`orders/ingest.ts`'s `ingestOrders`) PRIAMO vnútri
  jeho existujúcej DB transakcie — rovnaký vzor ako #268's napojenie na
  `posta-uncollected/run.ts`.** Nová `pgEnum` hodnota `vratenie`. `dedupKey`
  je `vratenie:<externalOrderId>` — na OBJEDNÁVKU, NIE na konkrétny
  pod-stav: prechod "Vratený tovar" → "Vybavený Dobropis" tej istej
  objednávky OBNOVÍ tú istú kartu, nikdy nevyrobí druhú (rovnaký princíp
  ako `posta-uncollected`'s dedup na ZÁSIELKU, nie na jej okamžitú
  klasifikáciu). Presný zoznam rozpoznaných stavov (`orders/return-status.ts`'s
  `classifyReturnStatus`) bol OVERENÝ ŽIVO na produkčnej DB pred
  implementáciou (`docker exec forestshop-postgres-1 psql ... GROUP BY
  status_name`) — presne tri stavy z tela ticketu, žiadny ďalší. Karta sa
  NIKDY nezatvára automaticky (na rozdiel od #268) — ticket to explicitne
  žiada, majiteľ ju zavrie ručne cez "Vybavené". `shoptetOrderId` pre odkaz
  do administrácie sa berie PRIAMO z `orderIdsByCode` (best-effort XML
  fetch, už načítaná mapa vnútri tej istej funkcie) — žiadny extra dopyt.
- **`upsertUpozornenie()` mal TOCTOU medzeru (issue 272, objavené code
  review-om pri #267, opravené pri #268 — prvom reálnom automatickom
  volajúcom): samostatný `SELECT` a podľa jeho výsledku podmienený
  `UPDATE`/`INSERT`, bez transakcie.** Fix je JEDEN atomický príkaz —
  drizzle's `.insert(...).onConflictDoUpdate({ target: upozornenie.dedupKey,
  targetWhere: sql\`resolved_at IS NULL\`, set: {...} })`. **`targetWhere`
  MUSÍ textovo zrkadliť presne ten istý predikát, aký má samotný ČIASTOČNÝ
  unique index** (`upozornenie_dedup_key_uq ... WHERE resolved_at IS NULL`,
  vyššie v tomto súbore) — Postgres-ova ON CONFLICT inferencia potrebuje
  zhodu cieľových stĺpcov AJ predikátu, inak arbiter index nerozpozná a
  konflikt sa nevyrieši. `dedupKey: null` (vlastné poznámky) sa tohto NIKDY
  netýka — Postgres nikdy nepovažuje dve `NULL` hodnoty v unique indexe za
  zhodné, takže vlastné poznámky ostávajú vždy nový riadok. Prvé použitie
  `targetWhere` v tomto repe — vzor pre KAŽDÝ ĎALŠÍ atomický upsert na
  ČIASTOČNOM unique indexe.
- **Test dokazujúci opravu TOCTOU race-u potrebuje PREDHRIATY connection
  pool, inak sa "závod" v praxi nikdy nestretne.** Na studenom pripojení
  (0 idle spojení v poole) dominuje latencia TCP handshaku (~15-20ms na
  tomto Dockeri) nad latenciou samotného SQL dopytu (~3ms) — prvé volanie,
  ktoré náhodou dostane pripojenie skôr, stihne CELÝ SELECT+INSERT cyklus
  skôr, než ostatné vôbec stihnú odoslať svoj SELECT, takže test by ticho
  prešiel AJ na chybnom (select-then-branch) kóde. Overené priamym
  `pg.Pool` pokusom mimo vitestu (issue 272): bez predhriatia 5/5 "OK", s
  predhriatím 2/5 "duplicate key" na starom kóde. Fix: `N` súbežných
  `db.execute(sql\`select 1\`)` (cez `Promise.all`) PRED samotným závodom —
  zabezpečí `N` HOTOVÝCH (idle) fyzických pripojení v poole, takže samotný
  test už pretekáva len o rýchlosť SQL, nie o pripojenie
  (`upozornenia-service.integration.test.ts`'s "súbežnosť" blok). Ani
  predhriaty pool negarantuje 100 % zásah pri KAŽDOM behu — vyššia
  `CONCURRENCY` (10, nie 2) zvyšuje šancu zásahu v jednom behu, ale
  nezaručuje ju absolútne; to je vlastnosť testovania závodu na reálnej
  DB, nie chyba tejto techniky. Rovnaký postup (predhriaty pool + vyšší
  počet súbežných volaní) použi pri KAŽDOM ĎALŠOM teste, čo dokazuje opravu
  TOCTOU/race-u cez skutočný Postgres, nie mock.
- **Issue 269 (živé overenie na 0.3.0-dev.160): vybavené vrátenie sa PO
  ĎALŠOM importe znova vyrobilo ako DRUHÁ karta — DRUHÝ krát, čo tento istý
  ČIASTOČNÝ index (`WHERE resolved_at IS NULL`) prekvapil (prvý bol #272's
  TOCTOU vyššie).** Príčina: index dovoľuje ĎALŠÍ výskyt PO vyriešení prvého
  — zámerné pre #268 (zásielka sa smie o mesiac znova zaseknúť), ale pre
  `vratenie` je vybavený riadok KONEČNÝ, nikdy sa nemá zopakovať. **Poučenie
  pre KAŽDÝ ĎALŠÍ budúci automatický zdroj, čo bude volať `upsertUpozornenie`
  s vlastným `dedupKey`:** rozhodni sa VOPRED a EXPLICITNE, do ktorej z dvoch
  kategórií patrí — "znova sa smie ohlásiť po vybavení" (#268, žiadna extra
  práca, `upsertUpozornenie` samo osebe stačí) VERZUS "vybavené je KONEČNÉ,
  nikdy sa nemá zopakovať" (#269) — ten druhý prípad si musí sám dopísať
  vlastný existence pre-check (nikdy zmenu `upsertUpozornenie`/schémy/indexu
  samotného, ktoré ostávajú zdieľané a nezmenené pre PRVÚ kategóriu).
- **Existence pre-check pre "KONEČNÉ" kategóriu (`orders/ingest.ts`'s
  `resolvedReturnDedupKeys`) je JEDEN batchovaný `SELECT ... WHERE dedup_key
  IN (...) ... .for("update")` nad VŠETKÝMI kandidátmi TOHO ISTÉHO behu
  naraz, NIE dopyt v cykle** — `.for("update")` je POVINNÉ, nie voliteľné
  vylepšenie: bez neho je to obyčajné READ COMMITTED čítanie, ktoré sa
  NIKDY nezablokuje na súbežnom ručnom "Vybavené" (`resolveUpozornenie`, mimo
  tejto transakcie) — ten by mohol commitnúť PRESNE medzi pre-checkom a
  neskorším `upsertUpozornenie` volaním PRE TEN ISTÝ kandidát, čím by sa ten
  istý bug zopakoval, len naživo zriedkavejšie (code review nález, nie
  pôvodný test). `.for("update")` zamkne KAŽDÝ existujúci kandidátny riadok
  na zvyšok transakcie (rovnaký vzor ako `orders/state.ts`/`.claude/rules/
  database.md`) — súbežné `resolveUpozornenie` naň POČKÁ, takže rozhodnutie
  je vždy postavené na ČERSTVOM, nie zastaranom stave. Bez JOINu (jedna
  tabuľka) nepotrebuje `of` zoznam.
- **Set-based dávkový skip (`resolvedReturnDedupKeys.has(dedupKey)`)
  POTREBUJE explicitný test s ≥2 kandidátmi v JEDNOM behu, kde je vybavený
  LEN JEDEN — jednotlivé (1-kandidátové) testy nedokážu odhaliť regresiu na
  "všetko alebo nič za celú dávku" namiesto správneho rozlíšenia PO
  KĽÚČOCH.** (`orders-ingest-return-upozornenie.integration.test.ts`'s
  "v jednom importe s viacerými..." test — pridané až pri code review, nie
  v pôvodnom RED/GREEN páre.) Test na KAŽDÝ ĎALŠÍ Set/Map-based dávkový
  rozhodovací mechanizmus v tomto module: over samostatne, že jeden člen
  dávky neovplyvní rozhodnutie o INOM členovi tej istej dávky.
- **Deterministický dôkaz, že `.for("update")` fix naozaj UZAVIERA TOCTOU
  okno (nie len "vyzerá správne"), potrebuje `pg_blocking_pids` SCOPOVANÝ na
  KONKRÉTNY backend pid, nie holé `pg_stat_activity WHERE wait_event_type =
  'Lock'`** (`.claude/rules/database.md`'s technika, spresnená) — tento box
  beží súbežné testovacie/vývojové relácie na tej istej lokálnej Postgres
  inštancii, takže holý "čaká NIEKTO na NEJAKÝ zámok" dopyt môže dať falošný
  pozitív z úplne nesúvisiacej aktivity. Správny dopyt: `SELECT count(*)
  FROM pg_stat_activity a WHERE a.wait_event_type = 'Lock' AND $1 = ANY
  (pg_blocking_pids(a.pid))`, kde `$1` je PRIAMO `rawClient`'s vlastný
  `pg_backend_pid()` (zistený ihneď po pripojení, pred `BEGIN`).
  **Prekvapenie objavené priamym dočasným odstránením `.for("update")` a
  behom testu proti starému kódu (nie len úvahou):** `INSERT ... ON CONFLICT`
  sám osebe ČAKÁ na uvoľnenie riadkového zámku súbežnej transakcie na
  kandidátnom riadku (Postgres to potrebuje na správne vyhodnotenie
  arbitra) — takže "niekto sa zasekol na `rawClient`'s zámku" bolo PRAVDA
  aj BEZ nášho `.for("update")`, len na INOM mieste (samotný `INSERT`, nie
  náš pre-check). To znamená: samotný "zaseknutý?" medzikrok NEROZLIŠUJE
  opravený/neopravený kód — dokazuje len že test vytvoril SKUTOČNÝ súbeh
  (nie no-op). **Skutočný dôkaz opravy je AŽ finálna asercia počtu
  riadkov** (bez opravy 2 riadky, s opravou 1) — over to VŽDY OBOMA smermi
  (dočasne odstrániť opravu → test spadne presne na tomto mieste, vrátiť →
  zelený), presne ako `.claude/rules/regression-test-first.md` vyžaduje pre
  RED/GREEN, aj keď ide o code-review-dodaný test mimo pôvodného páru.
- **Dopyt, ktorý potrebuje VYRIEŠENÉ riadky, nemôže použiť `upozornenie_dedup_key_uq`
  — ten je ČIASTOČNÝ (`WHERE resolved_at IS NULL`).** Pre-check vrátkových
  kandidátov preto bez samostatného PLNÉHO btree indexu na `dedup_key`
  (`upozornenie_dedup_key_idx`, migrácia `0040`) seq-skenoval celú tabuľku na
  KAŽDOM behu importu — a tá tabuľka odteraz rastie monotónne, lebo vyriešené
  vrátkové karty sa už nikdy nemažú. Vždy, keď pridávaš dopyt nad `dedup_key`
  mimo predikátu `resolved_at IS NULL`, over si, či existuje index, ktorý ho
  vie obslúžiť.
- **Skip podľa "existuje vyriešený riadok" musí zohľadniť aj OTVORENÉHO
  súrodenca.** Kľúč môže mať SÚČASNE vyriešený aj otvorený riadok (presne stav,
  ktorý pôvodný bug stihol vyrobiť) — ak sa skipne celý kľúč, otvorená karta
  navždy zamrzne na starom titulku/pod-stave. Správne: skip len keď pre kľúč
  NEEXISTUJE žiadny nevyriešený riadok (`hasUnresolvedByKey`), plus regresný
  test, ktorý taký zmiešaný stav priamo nasadí.
- **Blok, čo berie `.for("update")` zámky, patrí čo NAJNESKÔR v transakcii.**
  Zámky sa držia po jej zvyšok, takže keď pre-check bežal hneď po upserte
  objednávok, klik majiteľa na "Vybavené" čakal na dobehnutie CELÉHO zvyšku
  importu (validácia variantov + dávkové vkladanie `order_line`). Presunutím
  bloku tesne pred commit sa okno skráti na pár SQL príkazov. Podmienka
  presunu: blok číta len dáta pripravené mimo transakcie a nič po ňom od neho
  nezávisí.
- **Test, kde oba behy dostanú ROVNAKÝ vstup, nedokáže odhaliť "preskočilo sa
  všetko".** Upsert prepíše byte-identické hodnoty, takže asercie prejdú aj
  pri pokazenej logike. Dávkový test musí druhému (neovplyvnenému) kandidátovi
  ZMENIŤ pod-stav a overiť, že sa titulok SKUTOČNE zmenil.
- **Issue 283 (majiteľ, komentár na tickete): "vrátenie vyriešenej karty späť
  medzi otvorené" (záložka "Vybavené", `returnUpozornenieToOpen`,
  `service.ts`) odchytáva kolíziu s `upozornenie_dedup_key_uq` PRIAMO z DB
  chyby JEDNÉHO atomického `UPDATE`u (SQLSTATE 23505, `constraint ===
  "upozornenie_dedup_key_uq"`), NIE cez samostatný SELECT-pred-UPDATE
  pre-check.** Ten istý vzor ako `catalog/ingest.ts`'s (neexportovaná)
  `isUniqueViolation` — duplikovaná v `upozornenia/service.ts` zámerne malá
  (mvp-philosophy: žiadna zdieľaná abstrakcia pre dvoch konzumentov v
  nesúvisiacich moduloch). Pre-check by znovu otvoril PRESNE tú TOCTOU triedu
  chyby, akú tento modul už dvakrát riešil na tom istom čiastočnom indexe
  (#272/#269, vyššie v tomto súbore) — atomický UPDATE + odchytenie chyby je
  race-proof z podstaty. Test na KAŽDÚ ĎALŠIU akciu na tomto module, ktorá
  môže naraziť na ČIASTOČNÝ unique index: over najprv, či existuje atomický
  SQL príkaz + chybu-odchytávajúci vzor, predtým než siahneš po
  SELECT-pred-zápisom pre-checku.
- **`GET /api/upozornenia/resolved` (história vybavených) je NOVÁ trasa, nie
  ďalší filter na existujúcej `GET /api/upozornenia`** — zámerne INÝ tvar
  výstupu (`resolvedByName` cez `LEFT JOIN users`) aj INÉ triedenie
  (`resolvedAt DESC`, nie `dueAt ASC`/`createdAt DESC`). Cap namiesto
  stránkovania (`RESOLVED_LIST_LIMIT = 200`) je rovnaký vzor ako `mail-log/
  queries.ts`'s pevný `limit: 200` — appka nikde inde nemá stránkovaciu UI.
- **Kolízia vrátenia (dva riadky s ROVNAKÝM `dedupKey`, jeden vyriešený a
  jeden otvorený) sa NEDÁ vyrobiť cez ŽIADNU appkinu UI akciu** — vlastné
  poznámky nikdy nenesú `dedupKey` (nikdy nekolidujú), a kartu s ním vyrába
  LEN automatický import (mimo dosahu bežného klikania). Preto ju overuje
  LEN service+HTTP integračný test (`upozornenia-resolved.integration
  .test.ts`/`upozornenia-resolved-http.integration.test.ts`), NIE Playwright
  e2e — rovnaký princíp ako `e2e-real-user-testing.md`'s výnimka pre backend
  scenáre, ktoré skutočný používateľ klikaním nikdy nevyrobí. E2E
  (`upozornenia.spec.ts`) namiesto toho overuje LEN to, čo je reálne
  dosiahnuteľné klikaním: záložka "Vybavené" + úspešné vrátenie karty späť.
- **Vyriešené karty žijú VÝHRADNE v záložke "Vybavené" (`UpozorneniaResolvedList`,
  `GET /api/upozornenia/resolved`) — záložka "Otvorené" ich NIKDY neukazuje.**
  Checkbox "aj vybavené" (pôvodný inline náhľad vyriešených kariet priamo v
  "Otvorené", predchodca záložky "Vybavené") bol issue 283-follow-up
  odstránený ako duplicitná zobrazovacia cesta pre tie isté dáta —
  `UpozorneniaSection.tsx`'s `load()` volá `fetchUpozornenia` s
  `includeResolved` NAPEVNO `false` (nie ovládané žiadnym UI filtrom).
  `includeResolved: true` na strane API OSTÁVA (`upozornenia-http
  .integration.test.ts` ho stále overuje) — používa ho VÝHRADNE
  `classifyEmptyMessage`'s doplnkový najširší dopyt (rozlíšenie "všetko je
  vybavené" od "všetko je odložené" v prázdnom zozname), nikdy priame
  zobrazenie karty. Nová "druhá" cesta na zobrazenie vyriešenej karty v
  "Otvorené" (checkbox, filter, čokoľvek) by túto duplicitu vrátila späť —
  nepridávaj ju.
- **AKTUALIZÁCIA (issue 297, 2026-08-06): "Karta sa NIKDY nezatvára
  automaticky" (bod vyššie o `vratenie`) UŽ NEPLATÍ pre CELÝ typ — platí len
  pre `Vratený tovar`.** Šéf (cez majiteľa): nástenka nemá upozorňovať na už
  HOTOVÉ veci. `orders/return-status.ts` sa preto rozdelilo na DVE nezávislé
  mapy: `classifyReturnStatus` (AKTÍVNY stav, dnes len "Vratený tovar" —
  zakladá/obnoví kartu, presne ako predtým) a `classifyFinishedReturnStatus`
  (HOTOVÉ stavy "Vybavená výmena"/"Vybavený Dobropis" — NIKDY nezakladajú
  kartu; namiesto toho AUTOMATICKY ZATVORIA existujúcu otvorenú kartu pre
  ten istý `dedupKey`, `resolvedByUserId` ostáva `null` — rovnaký princíp ako
  #268's doručená zásielka). **Objednávka, ktorá prešla z AKTÍVNEHO do
  HOTOVÉHO stavu, teda UŽ NEOBNOVÍ titulok karty na nový pod-stav (predošlé
  správanie) — namiesto toho kartu ZATVORÍ.** Celá logika (candidates loop +
  `.for("update")` pre-check + upsert + auto-resolve) je vyčlenená z
  `ingest.ts` do `apps/api/src/modules/orders/return-upozornenia.ts`
  (`applyReturnUpozornenia`) — `ingest.ts` narazilo na eslint `max-lines: 400`
  po pridaní finished-stavovej vetvy (`.claude/rules/testing.md`). Nový
  súbor duplikuje `ingest.ts`'s malý `chunk()` helper LOKÁLNE (import odtiaľ
  by vyrobil cyklickú závislosť — `ingest.ts` volá `applyReturnUpozornenia`),
  rovnaký princíp ako `service.ts`'s `isUniqueViolation`. **Existujúce
  otvorené karty pre HOTOVÉ stavy (12 na produkcii v čase ticketu) sa
  zatvoria NAŽIVO cez ĎALŠÍ naplánovaný `ordersImportJob` beh (hodinový,
  `:45`) — ŽIADNA jednorazová migrácia** (rovnaký mechanizmus, aký #269 už
  používa na OBNOVU existujúcich kariet): keďže objednávkový export nesie
  AKTUÁLNY Shoptet stav pri KAŽDOM importe, ďalší beh znova klasifikuje tú
  istú objednávku a nájde ju HOTOVÚ. Podmienka: objednávka musí ešte
  spadať do `DEFAULT_ORDERS_IMPORT_WINDOW_DAYS`-dňového posuvného okna
  exportu (`orders.md`) — vrátkové objednávky vznikajú krátko po nákupe,
  takže to v praxi vždy platí, ale je to PREDPOKLAD, nie záruka do
  nekonečna. Test na KAŽDÝ ĎALŠÍ prípad "táto karta sa má prestať zakladať a
  existujúce otvorené sa majú zatvoriť": over najprv, či nasledujúci
  naplánovaný beh prirodzene dorieši existujúce riadky (žiadna migrácia
  potrebná), predtým než sa píše jednorazový skript.
- **Issue 299: ŠTVRTÁ pgEnum hodnota `vratena_zasielka` (zásielka vrátená
  ODOSIELATEĽOVI podľa Pošta SK trackingu — nezamieňať s `vratenie`, tovar
  vrátený zákazníkom podľa STAVU OBJEDNÁVKY) — plné odôvodnenie vrátane
  KRITICKEJ poznámky "stateCode je odteraz potvrdený naživo (2026-08-07:
  returning/returned), no aj tak sa NIKDY necachuje ako trvalý" je v
  `.claude/rules/posta-uncollected.md`
  (rovnaký denný beh ako #268/`nevyzdvihnuta_zasielka`, aby sa neduplikovalo
  dvakrát). Migrácia `0041` (`ALTER TYPE ... ADD VALUE`), rovnaký vzor ako
  `vratenie`. **Prvý prípad DVOCH RÔZNYCH automatických zdrojov karty
  BEŽIACICH V TOM ISTOM `run.ts` priechode naraz** — `nevyzdvihnuta_zasielka`
  (dedupKey `posta:<číslo>`) a `vratena_zasielka` (dedupKey
  `posta-vratena:<číslo>`) sú SAMOSTATNÉ mená priestorov nad tou istou
  zásielkou, aby mohli koexistovať/prepínať sa bez kolízie na čiastočnom
  unique indexe.
- **Issue 301: PIATA pgEnum hodnota `objednavka_visi` — objednávka, ktorá dlho
  visí v NEVYBAVENOM stave** (`orders/stuck-status.ts`/`orders/stuck-
  upozornenia.ts`, napojené na TEN ISTÝ denný beh ako `vratenie` — import
  objednávok, `orders/ingest.ts`). Nevybavené stavy ("Vybavuje sa"/
  "Nevybavená") sú ZÁMERNE VLASTNÝ, nezávislý zoznam od admin-nastaviteľného
  `order_open_status` (`open-statuses.ts`) — presne tá istá úvaha ako
  `return-status.ts`'s vlastný vrátkový zoznam: keby šéf zajtra zmenil, čo sa
  ukazuje na "Na objednanie", TOTO upozornenie sa nesmie ticho spolu s ním
  prehodnotiť. `ORDER_STUCK_THRESHOLD_DAYS = 14` je zámerne ODLIŠNÝ (dlhší)
  prah než `order-reminder/constants.ts`'s `MIN_DAYS = 4` — ten rieši
  KRATŠIU, zákaznícky orientovanú vec (pripomenúť ZÁKAZNÍKOVI jeho
  objednávku), toto rieši ŠÉFOVI, že objednávka niekde v procese zamrzla;
  zdieľať jeden prah medzi oboma by bolo nesprávne, aj keby čísla náhodou
  vyšli rovnaké.
  **Kategorizačné rozhodnutie (`.claude/rules/upozornenia.md`'s vlastné
  poučenie z #269 vyššie — "rozhodni sa VOPRED, do ktorej z dvoch kategórií
  patrí"): `objednavka_visi` je ZNOVA-OHLÁSITEĽNÁ** (rodina #268's zásielky),
  NIE KONEČNÁ (rodina #269's `vratenie`) — objednávka, čo sa vráti späť do
  nevybaveného stavu a znova visí dosť dlho, má dostať NOVÚ kartu. Preto tu
  NIE JE potrebný žiadny `.for("update")` "je už KONEČNE vybavené" pre-check
  na `INSERT`-e — len jednoduchý `upsertUpozornenie`/`autoResolveByDedupKey`
  pár.
  **Auto-resolve VÝKONOVÁ past, ktorú by inak vyrobila práve TÁTO
  znova-ohlásiteľná voľba:** na rozdiel od `vratenie`'s malej množiny
  "HOTOVÝCH" kandidátov (`finishedReturnDedupKeys`) je "nie je nevybavené" pre
  túto kartu skoro KAŽDÁ objednávka v 90-dňovom okne — naivný `for`-cyklus,
  čo pre KAŽDÚ z nich zavolá `autoResolveByDedupKey` (bezpečný no-op bez
  existujúcej karty), by spravil stovky zbytočných `UPDATE`ov na KAŽDOM behu
  importu. `stuck-upozornenia.ts` preto NAJPRV dávkovo prečíta VŠETKY
  otvorené `objednavka_visi` dedup kľúče JEDNÝM dopytom a auto-resolve
  cyklus obmedzí LEN na tie — rovnaký "batch pre-check namiesto dopytu v
  cykle" princíp ako `#269`'s `.for("update")` pre-check vyššie v tomto
  súbore, len tu bez potreby zámku (kategória je znova-ohlásiteľná, takže
  TOCTOU na INSERTe nehrozí — zámok by tu riešil problém, čo v tejto
  kategórii vôbec neexistuje).
- **Issue 308 (založený 7.8.2026, deň PO #283) žiadal presne to, čo #283 už
  dodalo a naživo overilo deň predtým — zatvorené ako OBSOLETE bez jedného
  riadku kódu.** Ticketov telo citovalo majiteľov Discord komentár ("nedá sa
  vrátiť vybavené späť"), no `returnUpozornenieToOpen`/záložka Vybavené/
  tlačidlo "↩ Vrátiť medzi otvorené" už existovali a boli nasadené (PR #285,
  merge `579cff2`, live-overenie 6.8.2026 11:22) — #308 vzniklo AŽ 7.8.2026
  11:57, teda s viac než dennným oneskorením oproti tomu, čo appka už
  reálne robila. **Poučenie pre KAŽDÝ ĎALŠÍ ticket na tomto module, čo znie
  ako "X sa nedá spraviť":** over si NAJPRV, či #283/#297 (alebo novší
  komentár na tickete) už presne toto nedodalo — `.claude/rules/
  upozornenia.md`'s vlastná história je hustá práve preto, že táto oblasť
  sa mení rýchlo a ticket môže byť podaný neskoro, nie preto, že funkcia
  chýba. STEP 0 (`verify-issue-still-valid`) živé Playwright overenie proti
  produkcii (vlastná testovacia poznámka: vytvoriť → vybaviť → záložka
  Vybavené → vrátiť → späť v Otvorené → zmazať, 0 chýb v konzole) toto
  potvrdilo za pár minút, namiesto zbytočnej re-implementácie.
