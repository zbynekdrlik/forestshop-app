---
paths:
  - "docker-compose.yml"
  - "docker-compose.prod.yml"
  - "apps/api/drizzle/**"
  - "apps/api/drizzle.config.ts"
  - "apps/api/src/db/**"
  - "apps/api/src/index.ts"
---

# Database / Docker

- **`postgres:18-alpine` zmenil default `PGDATA`** na
  `/var/lib/postgresql/<major>/docker` namiesto klasického
  `/var/lib/postgresql/data`. Named-volume mount priamo na
  `/var/lib/postgresql/data` preto crash-loopuje (image ho vyhodnotí ako
  "unused mount" a odmietne štart —
  `docker-library/postgres#1259`). Fix: obe compose súbory (dev aj prod)
  explicitne pinujú `PGDATA: /var/lib/postgresql/data` v `environment:` sekcii
  `postgres` služby. Ak niekedy vznikne ďalší compose súbor s Postgres 18+
  named volume, potrebuje ten istý pin, inak zopakuje presne tento pád.
- **Ten istý PGDATA pin má DRUHÝ dôsledok: obraz deklaruje `VOLUME
  /var/lib/postgresql`, ale my pripájame pomenovanú priehradku až na jeho
  podpriečinok `data` — takže docker si pri KAŽDOM prestavaní kontajnera
  vyrobí navyše bezmennú (anonymnú) priehradku pre ten nadradený priečinok.**
  Zmerané na dev2 pri issue 206: z 245 osirelých bezmenných priehradiek bola
  presne jedna 4 KB (naša), zvyšok po ~40 MB patril inému projektu. Fix (issue
  209): pridať DRUHÚ pomenovanú priehradku `pgparent:/var/lib/postgresql` PRED
  riadok s `pgdata` — vnorený mount ide dovnútra, dáta zostávajú v `pgdata` a
  NEPRESÚVAJÚ sa. Overené lokálne na odhodenom kontajneri predtým, než sa to
  pustilo na produkciu: kontajner nabehol (`pg_isready` do 6 s), zápis spravený
  pred prestavaním sa po prestavaní načítal späť, a počet osirelých priehradiek
  sa nezmenil. **Každý ďalší compose súbor s Postgres 18+ potrebuje OBA riadky,
  nielen `PGDATA` pin** — inak zopakuje presne tento únik.
- CI `integration`/`e2e` joby bežia Postgres bez volume mountu vôbec (services
  kontajner, efemérny) — tento problém sa tam nikdy neprejaví, len pri
  lokálnom/prod behu s perzistentným volume.
- **Migrácie bežia pri štarte aplikácie** (`apps/api/src/index.ts`), nie ako
  samostatný deploy krok — `deploy.yml` preto nemá vlastný migračný step,
  spolieha sa na to, že appka si to spraví sama pri boote kontajnera.
- **Drizzle-ov migrátor nedrží advisory lock.** Každá migrácia beží vo
  vlastnej transakcii (takže appka nikdy neobslúži polovične zmigrovanú
  schému), ale dve súčasne štartujúce inštancie by si mohli pretekať o rovnaké
  DDL. Netýka sa dnešného deploy flow (beží vždy presne jedna inštancia) —
  ak sa niekedy pridá druhá replika appky, toto sa musí doriešiť pred tým.
- **`drizzle-kit` 0.30.x nevie `db:generate`/`db:migrate`, keď jeden
  `src/db/schema*.ts` súbor cez `export * from "./other.js"` odkazuje na iný
  (napr. `schema.ts` re-exportuje `schema-catalog.ts`).** Jeho zabudovaný
  `esbuild-register` loader rieši `require()` čisto podľa Node-ovho klasického
  CJS resolvera — pri explicitnom `.js` (nutnom kvôli
  `verbatimModuleSyntax`/natívnemu ESM v `dist/`) nehľadá sesterský `.ts`
  súbor, takže padne na `MODULE_NOT_FOUND`, hoci `vitest`/`tsx` ten istý import
  bez problémov vyriešia. Fix: bump `drizzle-kit` na `^0.31.0` (vyriešené v
  0.31.10) — vymenil si interný TS loader a `.js → .ts` sesterský import
  vyrieši správne. Je to len devDependency (CLI, nie runtime `migrate()` v
  `index.ts`), takže bump nemení produkčné správanie; `drizzle-orm ^0.38.0`
  zostáva kompatibilné (interný `compatibilityVersion` check prejde). Ak
  pribudne ďalší `schema-*.ts` súbor s re-exportom, over `db:generate` hneď —
  ak `drizzle-kit` opäť klesol pod `^0.31.0`, toto je presne ten istý pád.
- **`drizzle-kit` (`^0.31.x`) je jeden release generation pred `drizzle-orm`
  (`^0.38.x`)** — review F1 Task 1 na to upozornil ako zvyškové riziko, nie
  ako aktuálnu chybu (`compatibilityVersion` check pri `db:generate` zatiaľ
  prechádza bez varovania). Kým sa obe knižnice nezarovnajú na rovnakú
  generáciu, každú vygenerovanú `.sql` migráciu si pred commitom prečítaj —
  neber jej obsah len na základe toho, že `db:generate` prebehlo bez chyby.
- **Paralelné worktree workery generujú KOLÍZNE čísla migrácií** (13. 8. 2026:
  issue 402 aj issue 397 vytvorili nezávisle `0050_*.sql` — obe vetvy
  vychádzali z rovnakého dev). Supervisor to rieši PRI INTEGRÁCII: migrácia,
  ktorá už je NASADENÁ na produkcii (over `origin/main` ancestry, nie poradie
  merge-ov v dev!), si číslo nechá; nenasadená sa prečísluje (`git mv`) +
  `meta/_journal.json` (idx, tag, `when` ostro rastúce) + jej snapshot dostane
  `prevId` = id ponechanej migrácie — a ak snapshot druhej vetvy neobsahuje
  zmeny prvej, treba ho REKONŠTRUOVAŤ (snapshot ponechanej + schema-zmeny
  prečíslovanej), inak najbližší `db:generate` tie zmeny zahodí. Po vyriešení
  over na čistom Postgrese (`docker run … postgres:18` + `db:migrate`;
  premenovanie nemení hash — drizzle hashuje OBSAH .sql). Prevencia: dvom
  súbežným workerom, čo oba pridajú migráciu, prideľ čísla dopredu ako verzie.
- **Funkcia, ktorá má bežať AJ na top-level `db`, AJ vnútri `db.transaction(async (tx) => ...)`,
  nesmie typovať svoj parameter ako `Database`** (`db/client.ts`'s
  `NodePgDatabase<schema> & {$client: Pool}`) — `tx` je `PgTransaction`,
  ktorý zdieľa spoločného predka (`PgDatabase`) a má rovnaký `.insert()`/
  `.select()`/`.update()`/`.delete()` tvar, ale CHÝBA mu `$client`, takže
  `tsc` (s `exactOptionalPropertyTypes: true`) odmietne `tx` ako argument
  typu `Database`. Fix: zúž parameter na `Pick<Database, "insert">` (alebo
  ktorákoľvek metóda skutočne potrebná) namiesto celého `Database` — to je
  presne to, čo `modules/audit/service.ts`'s `record()` robí (`AuditExecutor`
  typ), aby ho bolo možné volať `record(tx, ...)` vnútri transakcie
  (#10, `changePassword`). Rovnaký test pri KAŽDEJ ďalšej zdieľanej funkcii:
  potrebuje volajúci naozaj CELÝ `Database`, alebo len pár metód?
- **Nový `schema-<oblasť>.ts` súbor, ktorý potrebuje `users`/`sessions`/
  `audit_events`, si NESMIE po ne siahnuť cez `./schema.js` (barrel)** — `schema.ts`
  re-exportuje KAŽDÝ `schema-*.ts` súbor cez `export *`, takže import z barrelu
  vytvorí kruh (`schema.ts` → nový súbor → `schema.ts`). Preto sú `users`/
  `sessions`/`audit_events` od #44 vo vlastnom sibling súbore
  `schema-users.ts` (schema.ts je odvtedy ČISTÝ barrel, žiadne vlastné
  definície) — nový `schema-*.ts` importuje `users` odtiaľ priamo, presne ako
  `schema-orders.ts` importuje `variants` z `schema-catalog.ts`. Rovnaký test
  pri každom ďalšom novom `schema-*.ts`: potrebuje niečo z `users.ts`/inej
  sibling tabuľky? Import PRIAMO z toho súboru, nikdy cez `schema.js`.
- **CHECK, ktorý viaže STAV na DVA nullable stĺpce naraz, sa NEDÁ vyjadriť
  bare rovnosťou booleovských výrazov** (vzor `catalog_snapshot_reason_ck`,
  jeden stĺpec, funguje bezpečne) — `(state = 'X') = (a IS NOT NULL AND b IS
  NOT NULL)` prepustí POLOVIČNE vyplnený riadok (`state != 'X'`, jeden z
  `a`/`b` vyplnený, druhý null), lebo pravá strana potrebuje byť len `false`,
  čo platí už pri JEDNOM null stĺpci, nie len pri OBOCH. Nájdené code review
  na PR #50 (`pairing_confirmation_ck`, #44), overené naživo proti Postgresu
  pred opravou. Správny tvar je explicitný dvojsmerný OR, ktorý vyžaduje OBA
  stĺpce zhodne v každej vetve:
  ```sql
  CHECK (
    (state = 'X' AND a IS NOT NULL AND b IS NOT NULL)
    OR (state != 'X' AND a IS NULL AND b IS NULL)
  )
  ```
  Test na KAŽDÝ ďalší viac-stĺpcový CHECK tohto tvaru: napíš test pre
  POLOVIČNÚ kombináciu (jeden stĺpec vyplnený, druhý null), nielen pre "oba
  vyplnené v zlom stave" a "oba prázdne v zlom stave" — presne tá tretia
  kombinácia je to, čo bare rovnosť tichο prepúšťa.
- **`onDelete: "set null"` na FK stĺpci, ktorý je súčasťou CHECKu viažuceho
  ho na `state` (vzor vyššie), NEMUSÍ reálne nikdy nastať** — ak CHECK
  vyžaduje ten stĺpec NOT NULL práve vtedy, keď je `state` v danom stave, set
  null vždy poruší CHECK skôr, než sa uplatní, takže Postgres delete odmietne
  s CHECK-violation namiesto FK-violation. Zistené code review na PR #50
  (`pairing.confirmed_by`, deklarované "set null" ako mirror
  `audit_events.actor_user_id`, ale `pairing_confirmation_ck` to nikdy
  nedovolí) — oprava bola zmeniť FK na `onDelete: "restrict"` (skutočné
  správanie sa nezmenilo, len sa zosúladil deklarovaný zámer s realitou).
  Test na KAŽDÚ ďalšiu takúto FK+CHECK kombináciu: over, či `onDelete` reálne
  vie nastať v STAVE, kde CHECK vyžaduje ten stĺpec vyplnený — ak nie,
  `restrict` je pravdivejší popis než `set null`/`cascade`.
- **`SELECT ... FOR UPDATE` (drizzle's `.for("update")`) BEZ `of` zoznamu
  zamyká riadky VO VŠETKÝCH tabuľkách JOINu, nielen v primárne vybranej —
  a KEĎ to spraví zbytočne pre tabuľky, ktoré zápis vôbec nemení, riskuje
  DEADLOCK s inou transakciou, čo tie isté tabuľky zamyká v OPAČNOM poradí,
  nielen zbytočné čakanie.** Postgres dokumentácia: locking klauzuly bez
  `OF` zoznamu ovplyvňujú všetky tabuľky použité v príkaze. Review of PR 75,
  finding 3 (`orders/queries.ts`'s `listOpenOrderLineIdsForSupplier`, ktorý
  JOINuje `order_line`/`order`/`variant`/`product`): presun tohto dopytu
  VNÚTRI transakcie `setSupplierLinesOrdered` (`state.ts`) spolu s
  `.for("update")` (VTEDY ešte bez `of` zoznamu) zatvoril TOCTOU okno
  (súbežný re-import/per-riadkový toggle už nemôže zmeniť "otvorenú"
  množinu medzi čítaním a zápisom) — ale review of PR 76, finding 1 hneď
  potom odhalil, že ten istý bezzoznamový zámok POKRÝVAL AJ `variant`/
  `product`, hoci tento zápis mutuje LEN `order_line`. `catalog/ingest.ts`
  berie svoj dlhý import v poradí produkt → variant (upsert produktov, potom
  variantov, plus záverečný hromadný `UPDATE variant`), zatiaľ čo LockRows
  uzol tohto dopytu by zamykal v opačnom poradí rozsahovej tabuľky
  (order_line → order → variant → product) — opačné poradie zámkov medzi
  dvomi transakciami je klasický predpoklad na deadlock, nielen na čakanie.
  Konečná oprava: `.for("update", { of: [orderLines, orders] })` — TOCTOU
  uzáver zostáva (zámok stále pokrýva `order`), katalógové tabuľky sa už
  nezamykajú vôbec. **Pravidlo pre KAŽDÉ ďalšie `.for("update")` cez JOIN:
  `of` zoznam sa vyberá podľa toho, ČO zápis SKUTOČNE mutuje, nikdy podľa
  toho, čo JOIN len na filtrovanie/čítanie potrebuje** — aj keď na
  uzavretie TOCTOU okna stačí zamknúť viac než primárnu tabuľku (tu aj
  `order`, nielen `order_line`), nikdy nezamykaj tabuľku, ktorú tento zápis
  vôbec nemení.
  Dva doplňujúce regresné testy (`tests/orders-supplier-bulk-lock
  .integration.test.ts`, rovnaká technika ako `orders-state-lock
  .integration.test.ts`) dokazujú OBE vlastnosti nezávisle:
  1. **TOCTOU uzáver stále platí** — drží `SELECT ... FOR UPDATE` z druhého
     pripojenia na `order` riadku (NIE `order_line`); obyčajný nezamknutý
     SELECT (stav pred pôvodnou PR 75 opravou) by naň vôbec nečakal.
  2. **Katalógové tabuľky už nie sú zamknuté** — drží zámok na `product`
     riadku (súčasť JOINu, ale mimo `of` zoznamu) a NEUVOĽNÍ ho, kým sám
     testovaný `await` nedokončí; na bezzoznamovom `.for("update")` (stav
     pred touto opravou) by preto `await` nikdy nedokončil a test by
     spoľahlivo padol na `testTimeout` (30s) namiesto rýchleho prejdenia.
  Rovnaký dvojitý test na ĎALŠIU takúto opravu: over ZVLÁŠŤ, že žiadaný
  zámok (tabuľka, na ktorej TOCTOU skutočne závisí) stále blokuje, AJ že
  nežiaduci zámok (tabuľka mimo `of` zoznamu, ale v tom istom JOINe) už
  neblokuje — jeden test dokazujúci len jednu z dvoch vlastností by druhú
  regresiu (návrat k celoplošnému zámku, alebo príliš úzky zámok, čo znovu
  otvorí TOCTOU) nechal nepovšimnutú.
  **Deterministický "NEBLOKUJE" dôkaz bez čakania na promise-timing:**
  namiesto sledovania JS-strany flagu (`.then()` nastaveného flagu) sa
  "je/nie je ešte zaseknuté na zámku" dá zistiť PRIAMO z Postgresu —
  `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND
  pid <> pg_backend_pid()` z druhého pripojenia, opakovane pollované do
  krátkeho deadline. Review of PR 76, finding 2 + 4 nahradil pôvodný pevný
  200ms `setTimeout` + neošetrený `.then()` (na preťaženom CI runneri mohla
  aj pred-opravová odomknutá cesta trvať dlhšie než 200ms → falošne zelený
  test; nerejectovaný `.then()` mohol unhandled rejection pripísať
  neskoršiemu testu v tom istom jednoprocesovom behu) presne týmto —
  `withCleanDb()`'s advisory izolačný zámok + `fileParallelism: false`
  (`.claude/rules/testing.md`) garantujú, že žiadny INÝ backend v tú chvíľu
  nebeží, takže "niekto je zaseknutý na zámku" môže byť len testovaný kód.
- **Funkcia, ktorá má bežať aj s `tx`, potrebuje zúžený parameter aj pre
  `.select()`, nielen pre `.insert()`** (rozšírenie vzoru vyššie z `audit/
  service.ts`'s `AuditExecutor`) — `orders/open-statuses.ts`'s
  `listOpenStatusNames` a `orders/queries.ts`'s
  `listOpenOrderLineIdsForSupplier` majú teraz `Pick<Database, "select">`
  namiesto celého `Database`, aby ich šlo volať aj s `tx` (`PgTransaction`
  nemá `Database`'s `$client`).
- **`\s` (a KAŽDÝ iný jednopísmenový backslash-escape, ktorý JS
  nepozná — `\d`, `\w`, ...) VNÚTRI drizzle's `sql` tagovaného šablónového
  literálu TICHO STRATÍ backslash** — JS šablónové/reťazcové literály
  neuznávajú `\s` ako escape sekvenciu, takže `` sql`... '\s+' ...` ``
  reálne odošle na Postgres text `'s+'`, nie `'\s+'` (regex na
  whitespace). Zistené issue 63 (`modules/orders/supplier-key.ts`'s
  `normalizedSupplierKeySql`, `regexp_replace(..., '\s+', ' ', 'g')`) —
  `.toSQL()` na dopyte ukázal presne túto tichú zmenu, funkcia preto
  prestala zbierať viacnásobné medzery (namiesto zlúčenia dvoch pravopisov
  dodávateľa do jednej skupiny nechala kľúč nezmenený). Fix: `\\s+`
  (dvojitý backslash) — jediný spôsob, ako dostať doslovné `\s+` do SQL
  textu z JS šablóny. Pri KAŽDOM ďalšom raw regexe/escape sekvencii vnútri
  `sql` šablóny over `drizzle`'s `.toSQL().sql` (alebo `q.toSQL()`) priamo
  proti reálnej DB predtým, než tomu dôveruješ — "vyzerá to ako správny SQL
  text v zdrojáku" nestačí, JS parsing šablóny beží PRED tým, než sa
  reťazec vôbec dostane k drizzle.
- **`.orderBy(...)` sa NESMIE odvolávať na `select`-ov ALIAS pomenovaný
  agregátnym `count(*) filter (where ...)` výrazom cez `sql\`aliasMeno\``
  — drizzle taký alias negeneruje ako bežný výstupný stĺpec, Postgres
  vráti `column "aliasMeno" does not exist` (issue 227, naživo overené
  integračným testom, `supplier-stock/queries.ts`'s
  `getSupplierStockHostOverview`). Code review navrhol `desc(sql\`total\`)`
  namiesto opakovaného `desc(sql\`count(*)\`)` ako "menej duplicitné" — pri
  reálnom behu to zhodilo `GET /api/supplier-stock` na 500. Fix: vrátiť sa
  k opakovanému `count(*)`/inému AGREGÁTNEMU VÝRAZU priamo v `ORDER BY`,
  nikdy sa nespoliehať na alias z `FILTER`-ovaného `sql` výrazu. Test na
  KAŽDÝ ĎALŠÍ pokus "zjednodušiť" `ORDER BY` odkazom na alias z podobného
  agregátu: over PRIAMO integračným testom proti reálnej DB (nie len že
  `tsc`/`eslint` prejdú) — statická kontrola typov toto nezachytí.
- **Nová `pgEnum` hodnota (`ALTER TYPE ... ADD VALUE`, napr. `mail_log_source`)
  je NA LOKÁLNEJ Postgres inštancii neviditeľná, kým nebeží `pnpm --filter
  @forestshop/api db:migrate` — integračné testy/`e2e-setup.ts` proti nej
  BEŽIA ĎALEJ BEZ CHYBY, len TICHO stratia riadok.** Issue 257
  (`mail_log_source` pridalo `'order_merge'`): `mail-log/service.ts`'s
  `insertEntry` zámerne NEVYHADZUJE pri zlyhanom zápise (len `log.error` +
  `return` — "zlyhanie zápisu do knihy nesmie zhodiť samotné odosielanie"),
  takže `POST /api/order-merge/send` proti neaktualizovanej lokálnej DB
  vrátil `{ok:true}` (fake mail transport dostal správu), ale `SELECT *
  FROM mail_log` vrátil 0 riadkov — vyzeralo to ako bug v novom kóde,
  skutočná príčina bola len zabudnutý `db:migrate` po pridaní migrácie
  (`.claude/rules/local-dev.md`'s bežný cyklus `db:migrate` → `test:
  integration`, jednoducho preskočený uprostred session). CI toto nikdy
  nezasiahne (ephemerálny Postgres, `db:migrate` je vlastný krok v
  `ci.yml`) — past je čisto lokálna. Test na KAŽDÚ ďalšiu novú `pgEnum`
  hodnotu pridanú migráciou: PRED spustením `test:integration` lokálne
  vždy `pnpm --filter @forestshop/api db:migrate` proti tej istej
  `DATABASE_URL` — a ak sa nejaký zápis "úspešne" prejde, ale zodpovedajúci
  SELECT ukáže menej riadkov, než očakávaš, over NAJPRV toto, nie logiku.
- **Čiastočný unique index (`uniqueIndex(...).on(...).where(sql\`...\`)`,
  drizzle-orm `^0.38.x`) je vzor pre "dedup KÝM je riadok v danom stave,
  ale ďalší výskyt PO tom stave je legitímny nový riadok"** — plný
  (nepodmienený) unique index by druhý výskyt po prvom vyriešení odmietol
  ako duplicitu. Prvý reálny prípad + plné odôvodnenie: issue 267's
  `upozornenie_dedup_key_uq` (`.claude/rules/upozornenia.md`), nájdené
  integračným testom PRED mergom, nie odhadom.
- **Drizzle-ov AUTO-generovaný FK názov (`<tabuľka>_<stĺpec>_<cudzia
  tabuľka>_<cudzí stĺpec>_fk`, keď je FK deklarovaná inline cez
  `.references(...)` na stĺpci) môže PREKROČIŤ Postgres-ov 63-bajtový
  `NAMEDATALEN` limit identifikátora, keď obe tabuľky majú dlhšie mená.**
  Postgres taký názov TICHO orezáva pri `CREATE TABLE`/`ALTER TABLE ADD
  CONSTRAINT` (žiadna chyba, žiadne varovanie), ale `drizzle-kit`'s
  snapshot JSON si pamätá PLNÝ, nikdy-neintrospektovaný názov — zistené
  issue 387 E3 review (`pairing_candidate.product_key` →
  `pairing_candidate_set.product_key`: auto-názov
  `pairing_candidate_product_key_pairing_candidate_set_product_key_fk` má
  69 znakov). Dôsledok: budúci `db:generate`, ktorý by túto konkrétnu FK
  menil (zmena `onDelete`, premenovanie stĺpca), by vygeneroval `ALTER
  TABLE ... DROP CONSTRAINT "<69-znakový názov>"` proti reálnej DB, kde
  constraint v skutočnosti existuje pod ORAZANÝM (63-znakovým) menom —
  migrácia by zlyhala na "constraint does not exist". Fix: pri KAŽDEJ
  novej FK medzi dvomi tabuľkami, ktorých mená + stĺpce dokopy prekročia
  ~55 znakov, nepoužívaj inline `.references(...)` — namiesto toho
  deklaruj stĺpec bez neho a pridaj explicitne pomenovanú `foreignKey({
  name: "<krátky-názov>", columns: [t.stlpec], foreignColumns:
  [cudziaTabulka.stlpec] }).onDelete("cascade")` do tabuľkinho
  constraint-array (`(t) => [...]`). Over PO KAŽDEJ takejto zmene: zresetuj
  lokálnu DB od nuly (`DROP SCHEMA public, drizzle CASCADE` — `drizzle`
  schéma nesie `__drizzle_migrations`, `TRUNCATE`/`DROP SCHEMA public` samo
  osebe ju NEVYMAŽE, takže opakovaný `db:migrate` po holom
  `public`-reset-e ticho preskočí VŠETKY migrácie ako "už aplikované" a
  nevytvorí žiadnu tabuľku) → `db:migrate` odznova → `select conname from
  pg_constraint where conrelid = '<tabuľka>'::regclass;` — potvrď, že meno
  je PRESNE také, aké si zadal, nie orezané.
