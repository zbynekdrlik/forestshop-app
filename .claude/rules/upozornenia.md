---
paths:
  - "apps/api/src/modules/upozornenia/**"
  - "apps/api/src/http/upozornenia-routes.ts"
  - "apps/api/src/db/schema-upozornenia.ts"
  - "apps/web/src/upozorneniaApi.ts"
  - "apps/web/src/components/Upozornenia*.tsx"
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
