---
paths:
  - "apps/api/tests/**"
  - "apps/api/src/**/*.test.ts"
  - "apps/api/vitest.config.ts"
  - "apps/web/vitest.config.ts"
  - "apps/web/src/**/*.test.ts"
  - "apps/web/src/**/*.test.tsx"
  - "apps/web/tests/e2e/**"
  - "apps/web/playwright.config.ts"
  - "scripts/e2e-setup.ts"
  - "scripts/e2e-fixtures-*.ts"
---

# Tests

- **`test:integration` a `e2e` sa lokálne na dev1 default NESPÚŠŤAJÚ (issue
  351)** — bežia bezpodmienečne v `ci.yml` (`.claude/rules/ci.md`), lokálne
  ostáva len `pnpm gates:local` (typecheck+lint+unit testy). Spusti tú
  jednu heavy sadu lokálne LEN keď tiket priamo zasahuje jej oblasť
  (obrazovky→e2e, DB/prihlásenie→integration), nikdy obe naraz, nikdy
  súbežne s ničím iným. Plný dôvod + namerané čísla: `.claude/rules/local-
  dev.md`.
- **Worktree-izolovaný autopilot dispatch (issue #317) pre tento repo môže
  reálne bežať PRIAMO na `forestshop-dev` (zdieľaný produkčný stroj), nie
  na `dev1` — over `hostname` PRED spustením ťažkej lokálnej sady, nikdy
  to nepredpokladaj len z projektového CLAUDE.md.** Zistené issue 397: `ps
  aux`/`hostname` ukázali, že worktree bežal na `forestshop-dev`, s
  DVOMA súbežnými sesterskými procesmi (background lint job + `pnpm
  install` iného paralelného worktree workera) — presne tá istá "preťažený
  zdieľaný box" kolízna trieda nižšie v tomto súbore, len s DOPLNKOVOU
  stávkou, že ten istý box beží aj ŽIVÚ PRODUKCIU (`.claude/rules/
  deploy.md`'s "Vývoj a produkcia bežia na TOM ISTOM 2-jadrovom stroji" —
  ťažký lokálny beh tam vie zhodiť produkčný Cloudflare tunel cez
  hladovanie po CPU, aj keď to cgroup `CPUWeight` mitigácia od 12. 8. 2026
  výrazne obmedzuje). Pri červenom e2e/integration výsledku na TOMTO repe
  over VŽDY najprv `hostname` + `ps aux | grep -E "vitest|playwright
  test|npm run|pnpm install"` (nielen `ps aux | grep vitest`, ako
  existujúci vzor nižšie predpokladá) — sesterský worktree worker nemusí
  spúšťať vitest/playwright priamo, môže bežať lint/install/iný unrelated
  príkaz, čo tiež zaberá CPU na 2-jadrovom stroji.
- **`apps/api` má dve úrovne testov, oddelené priečinkom aj scriptom:**
  - `src/**/*.test.ts` → `pnpm --filter @forestshop/api test` (`vitest run
    src`) — bežia BEZ databázy, čisto unit (napr. rate-limiter, password
    hashing).
  - `tests/**/*.test.ts` → `pnpm --filter @forestshop/api test:integration`
    (`vitest run tests`) — potrebujú `DATABASE_URL` (integration testy cez
    reálny Postgres, žiadne mocky).
  - Toto rozdelenie je to, čo umožňuje CI `check` jobu bežať `pnpm test` úplne
    bez databázy — nový test patriaci do `src/` s potrebou DB rozbije `check`,
    nie `integration`. Nový skutočný integration test → do `tests/`.
- **`apps/web/vitest.config.ts`** naberá len `src/**/*.test.{ts,tsx}` —
  Playwright specs v `apps/web/tests/e2e/**` nie sú vitestom nikdy pozbierané
  (žiadna kolízia, over pri zmene configu).
- **Playwright e2e (`apps/web/tests/e2e/login.spec.ts`) štartuje DVA servery**
  (API + Vite dev server, `playwright.config.ts`'s `webServer`) a PRED behom
  spustí `scripts/e2e-setup.ts`, ktorý TRUNCATE-uje `audit_events, sessions,
  users` a nasadí presne jedného e2e používateľa
  (`e2e@forestshop.sk` / `manazer`). Beh proti neprázdnej/starej DB je preto v
  poriadku — setup vždy začína od čistého stavu.
- **Console-assert v e2e má presne JEDNU povolenú výnimku:** neautentifikovaný
  `GET /api/me` odpovedajúci 401 (StrictMode dvojnásobne spúšťa efekt pri
  mounte, takže sa objaví 2-3× v jednom teste — to je legitímne, nie bug).
  Filter na túto výnimku (`jeOcakavane` v `login.spec.ts`) musí kontrolovať
  `ConsoleMessage.location().url`, NIE `ConsoleMessage.text()` — Chromium's
  "Failed to load resource" text nikdy neobsahuje URL, takže `text()`-based
  filter je natrvalo nefunkčný (vyzerá zeleno, no v skutočnosti nikdy nič
  neodfiltruje ani nič nezachytí). **Rozširovanie tejto výnimky na ďalšie
  cesty/kódy je zakázané** — každá ďalšia console error/warning musí byť
  vyriešená v appke, nie skrytá v teste.
- **Integračný test-súbor, ktorý volá `POST /api/login` viackrát, MUSÍ v
  `afterEach` zavolať `resetLoginRateLimit()`** (`src/http/login-rate-
  limit.ts`) — jeho počítadlo je modul-level singleton zdieľaný medzi
  všetkými testami v behu (aj naprieč súbormi, keďže `fileParallelism:
  false` drží všetko v jednom procese). Bez resetu sa počet prihlásení
  hromadí a niekde okolo 10. volania v poradí dostane 401/429 test, ktorý s
  rate-limitom vôbec nesúvisí — vyzerá to ako náhodné zlyhanie ďaleko od
  skutočnej príčiny. Vzor je v `http.integration.test.ts` aj
  `catalog-http*.integration.test.ts`.
- **Dva `boot()`-štýl helpery volané v JEDNOM teste sa navzájom prepíšu**,
  ak každý interne volá `withCleanDb()` — druhé volanie TRUNCATE-uje tie
  isté zdieľané tabuľky (vrátane `sessions`), takže zneplatní session
  vytvorenú prvým volaním skôr, než sa stihne použiť. Keď test potrebuje
  DVOCH súčasne prihlásených používateľov (napr. rôzne role), použi JEDEN
  spoločný `withCleanDb()`/`createApp()` a prihlás sa POD KAŽDÝM
  používateľom zvlášť, nie dva samostatné `boot()` volania.
- **Lokálne integračné testy sa už NErušia, keď bežia SÚBEŽNE proti tej istej
  zdieľanej lokálnej Postgres inštancii** (viac agentov/terminálov naraz) —
  vyriešené v issue #7. `withCleanDb()` (`tests/helpers/db.ts`) berie session
  `pg_advisory_lock` na VLASTNOM, samostatnom `pg.Client` pripojení (zámok je
  per-backend-session, nie per-pool — zdieľaný `drizzle` pool by ho mohol
  vziať na jednom pripojení a odomykať volanie poslať na inom) hneď na
  začiatku, pred TRUNCATE, a uvoľní ho až v `close()` — takže druhý súbežný
  proces na tej istej `DATABASE_URL` počká, kým prvý celý test doskončí,
  namiesto toho, aby sa jeho TRUNCATE prekryl s bežiacim testom. Kľúč
  (`TEST_DB_ISOLATION_LOCK_KEY = 787_878_100`, exportovaný z `db.ts`) je
  ZÁMERNE odlišný od `INGEST_ADVISORY_LOCK_KEY` (787_878_001,
  `ingest.ts`) — `pg_advisory_lock`/`pg_advisory_xact_lock` zdieľajú JEDEN
  priestor kľúčov bez ohľadu na to, ktorá funkcia zámok vzala, takže KAŽDÝ
  ĎALŠÍ advisory zámok pridaný do tohto repa musí dostať svoj vlastný,
  nekolidujúci literál — over oba existujúce kľúče, než pridáš tretí. Beh
  `withCleanDb()` sa preto navzájom SERIALIZUJE (nie paralelizuje) naprieč
  procesmi — v CI to nič nemení (každý job má vlastný efemérny Postgres
  kontajner, zámok tam nikdy nesúperí). Regresný test:
  `tests/db-isolation-lock.integration.test.ts` (deterministicky cez
  `pg_try_advisory_lock`, nie časovaním skutočnej TRUNCATE-kolízie).
- **`insertTestSnapshot`'s (`tests/helpers/catalog.ts`) predvolený `fetchedAt`
  je pre KAŽDÉ volanie ten istý literál**, ak ho neprepíšeš — dva snapshoty
  vložené bez explicitného `fetchedAt` majú teda ZHODNÝ čas, a dopyt, ktorý
  vyberá "posledný snapshot" (`desc(fetchedAt), desc(id)`), sa potom rozhodne
  podľa NÁHODNÉHO UUID tie-breaku, nie podľa poradia vloženia. Test, ktorý
  chce overiť "vyhrá TENTO konkrétny snapshot", MUSÍ dať oboch volaniam
  RÔZNY, explicitne rastúci `fetchedAt` (`NOW`/`NESKOR` alebo podobne) —
  inak je nedeterministický nezávisle od toho, či je testovaný kód správny
  (final-wave-a review, položka 3 aj 7 — presne takto vyzeral falošne
  nestály test lock-regresie, kým sa fetchedAt rozišiel).
- **Postgres advisory zámok (`pg_advisory_lock`/`pg_advisory_xact_lock`)
  zdieľa JEDEN priestor kľúčov bez ohľadu na to, ktorá z dvoch funkcií ho
  vzala** — session-scoped aj transakčná verzia sa navzájom blokujú, keď majú
  rovnaký číselný kľúč. To umožňuje DETERMINISTICKY (bez spoliehania sa na
  časovanie/`setTimeout` závody) otestovať kód chránený `pg_advisory_xact_lock`
  v transakcii: z DRUHÉHO pripojenia (`new pg.Client(...)`) zavolaj
  `pg_advisory_lock($1)` s tým istým kľúčom PRED spustením testovaného kódu —
  testovaný kód sa spoľahlivo zasekne presne na mieste zámku, kým ho
  manuálne neuvoľníš (`pg_advisory_unlock`). Pozri
  `catalog-ingest-lock.integration.test.ts`.
- **Nová "koreňová" tabuľka (nemá FK smerujúce DO žiadnej z tabuliek, ktoré už
  `withCleanDb()`'s TRUNCATE zoznam vypisuje) sa musí do toho zoznamu pridať
  RUČNE — `TRUNCATE ... CASCADE` sa šíri len JEDNÝM smerom.** `TRUNCATE
  variant CASCADE` automaticky vyprázdni aj `order_line` (lebo `order_line`
  referencuje `variant`), ale NEvyprázdni `order` (rodič `order_line`) —
  cascade ide smerom "čo odkazuje NA truncatovanú tabuľku", nikdy opačne. Bez
  explicitného pridania `order`/`order_line` do zoznamu v `tests/helpers/db.ts`
  by riadky `order` ticho prežívali medzi testami (#20). Test to hneď
  nevyhodí ako zlyhanie — prejaví sa až ako nevysvetliteľné medzi-testové
  dáta v tabuľke, ktorá vyzerá "nezávislá". Vzor: `"order"` je rezervované
  SQL kľúčové slovo, v raw SQL literáli (`sql\`TRUNCATE TABLE ...\``) MUSÍ byť
  ručne uvodzovkované (`"order"`) — drizzle-ove query buildre to robia
  automaticky, priamy SQL string nie.
- **`scripts/e2e-setup.ts` má VLASTNÝ, SAMOSTATNÝ `TRUNCATE` zoznam — nová
  tabuľka pridaná do `tests/helpers/db.ts` sa doň NEPREPÍŠE sama.** Issue 217
  našlo, že `supplier_stock`/`restock_settings`/`restock_event` (pridané pri
  #212/#213 správne do `tests/helpers/db.ts`) v e2e zozname chýbali — potvrdenia
  dodávateľa by teda prežívali z predošlého e2e behu do ďalšieho, presne tá
  istá tichá pasca, akú `.claude/rules/supplier-stock.md` popisuje pre
  integračné testy. Pri KAŽDEJ novej koreňovej tabuľke uprav OBA zoznamy naraz.
- **`upozornenie` tabuľka CHÝBA v OBOCH TRUNCATE zoznamoch (`scripts/
  e2e-setup.ts` AJ `apps/api/tests/helpers/db.ts`) — nájdené issue 382,
  zapísané ako #384, zatiaľ NEOPRAVENÉ.** Neškodilo to, kým karty boli
  vždy `flex-direction: column` (vždy celá šírka, bez ohľadu na počet) —
  po issue 382's CSS Grid rozložení (`.upozornenia-list`) môžu
  NEVYMAZANÉ riadky z PREDCHÁDZAJÚCEHO lokálneho behu (`upozornenia
  .spec.ts`'s hlavný flow test navyše ÚMYSELNE necháva 2 karty
  needeletnuté — testuje odloženie/vrátenie, nie mazanie) zmeniť SKUTOČNÝ
  počet stĺpcov mriežky, a teda aj šírku/výšku existujúcich testovaných
  kariet — presne toto najprv vyzeralo ako regresia v issue 327's teste
  ("pás akcií karty ≥25% nižší"), kým sa nenašlo, že príčinou boli
  LEFTOVER riadky z predchádzajúceho behu, nie samotná CSS zmena. Pred
  DÔVEROVANÍM akémukoľvek "regresia v `upozornenia.spec.ts`" nálezu na
  TOMTO lokálnom boxe: `docker exec <postgres-kontajner> psql -U
  forestshop -d forestshop -c "TRUNCATE TABLE upozornenie RESTART
  IDENTITY;"` a over znova, kým #384 nie je opravené.
- **Pridanie čo i len JEDNÉHO variantu do e2e seedu posunie pevné počty v
  `catalog.spec.ts`** (`"Nájdených: N"` aj `"Variantov v katalógu (vrátane
  chýbajúcich): N"`) — nie je to nič, čo by sa dalo obísť, len sa na to musí
  myslieť: zvýš obe čísla presne o počet pridaných variantov a do testu napíš,
  odkiaľ sa ten navyše vzal. Filtrované počty (`sellable`, `missing`) sa menia
  LEN ak nový variant do toho stavu patrí — issue 217 pridalo variant v stave
  `out_of_stock`, takže `6`/`1` zostali. Overené celým e2e balíkom, nie
  odhadom; opačné poradie (najprv predpoklad, že fixtúrny variant stačí)
  stálo jeden zbytočný beh — vo fixtúre NIE JE žiadny `out_of_stock` +
  `visible` variant s odkazom dodávateľa (overené dopytom do e2e databázy).
- **Nová "koreňová" tabuľka, ktorá NESIE reálny produkčný obsah (napr.
  seedovaný migráciou, nie len prázdna štruktúra) potrebuje po TRUNCATE aj
  RESEED, nielen pridanie do zoznamu.** `order_open_status` (issue 59) je
  ten istý prípad ako `supplier_contact`/`supplier` vyššie (žiadny FK v
  žiadnom smere), ALE navyše migrácia doň seeduje default riadok
  ("Vybavuje sa") — bez re-insertu HNEĎ po TRUNCATE by KAŽDÝ test začínal s
  PRÁZDNYM zoznamom, čo ticho vyprázdni "Na objednanie" pre úplne každý
  test, čo naň spolieha (skoro všetky). Vzor: exportovaná konštanta
  (`DEFAULT_ORDER_OPEN_STATUS` v `modules/orders/open-statuses.ts`) namiesto
  reťazcového literálu na dvoch miestach (`tests/helpers/db.ts` +
  `scripts/e2e-setup.ts`), aby default nikdy nerozišiel medzi migráciou a
  testovými pomôckami. Test na KAŽDÚ ďalšiu takúto tabuľku: nesie
  seedovaný/predvolený obsah, na ktorý sa iné testy SPOLIEHAJÚ? Ak áno,
  po TRUNCATE treba reseed, nielen pridanie do zoznamu.
- **Standalone skript v `scripts/*.ts` (mimo TS projektu `apps/api`) hlási
  falošné `@typescript-eslint/no-unsafe-*` na AKÝKOĽVEK priamy import z
  `"drizzle-orm"`** — nielen na tagovanú šablónu `sql` (ako pôvodne
  zdokumentované), ale aj na obyčajné funkcie ako `eq`. ESLint-ova
  type-aware kontrola tam nevie spoľahlivo odvodiť typy. Obchádzka:
  parametrizovaný/konštantný raw SQL reťazec priamo do `db.execute(...)`
  (rovnaký vzor ako existujúci `TRUNCATE` v `scripts/e2e-setup.ts`), nie
  query builder.
- **Chromium loguje "Failed to load resource" do konzoly pre KAŽDÝ `fetch()`
  s odpoveďou 4xx/5xx, bez ohľadu na to, či ho JS odchytí** — nielen pre
  `/api/me` 401 (jediná dnes zdokumentovaná výnimka vyššie). Endpoint, ktorého
  BEŽNÝ, OČAKÁVANÝ domain-level neúspech (napr. "zlé staré heslo" pri zmene
  hesla, #10) sa niekedy overuje aj cez Playwright s console-monitoringom,
  preto NESMIE vracať 4xx za taký prípad — porušilo by to zákaz rozširovania
  výnimky vyššie. Riešenie: vráť **200** s telom nesúcim výsledok
  (`{ok: false, error: "..."}`), rovnaký vzor ako `/api/catalog/ingest`'s
  200 `{status: "busy"}`/"rejected" pre iný nechybový výsledok importu — 4xx/5xx
  si nechaj pre SKUTOČNÉ HTTP-úrovňové chyby (401 nie si prihlásený, 403 CSRF,
  400 zle tvarovaný vstup, ktorý klient sám nedovolí odoslať). Pozri
  `http/app.ts`'s `POST /api/me/password` a
  `change-password.integration.test.ts`/`login.spec.ts`'s dvoj-kontextový
  e2e test — presne takto sa to odhalilo (e2e test napísaný najprv na 4xx
  zlyhal na tomto pravidle).
- **`@testing-library/react`'s `getByRole(..., { name })` robí PRESNÚ zhodu
  (celý accessible name musí sedieť), na rozdiel od Playwright's
  substring/case-insensitive zhody popísanej nižšie.** Pridanie `aria-label`
  na prvok (issue 70: `aria-label` s názvom produktu na odkaze "Odkaz na
  dodávateľa", aby riadky nemali identické prístupné meno) PREPÍŠE celý
  accessible name — existujúci vitest test s `getByRole("link", { name:
  "Odkaz na dodávateľa" })` prestane nachádzať prvok a treba ho upraviť na
  presný nový name (`` `Odkaz na dodávateľa — ${variantName}` ``). Playwright
  e2e testy s tým istým textom OSTANÚ fungovať bez zmeny — ich substring
  zhoda `"Odkaz na dodávateľa"` je stále obsiahnutá v novom dlhšom name.
- **`.claude/rules/testing.md`'s eslint `max-lines: 400` (skipBlankLines,
  skipComments) platí AJ na integračné testy, nielen unit testy** — pridanie
  jedného ďalšieho testu do `orders-http.integration.test.ts` (issue 70) ho
  poslalo cez limit. Zavedený vzor: vyčleniť tematicky súvislý blok (vlastný
  `boot()`, vlastné pomocné funkcie, vlastné testy) do NOVÉHO súboru s
  komentárom "Vydelené z X, aby ani jeden nenarástol cez limit" — presne
  ako existujúci `catalog-http.integration.test.ts` /
  `catalog-http-ingest.integration.test.ts` split. Nový vzor: `orders-http
  .integration.test.ts` (čítanie + import) / `orders-http-state.integration
  .test.ts` (#25 zmena stavu riadku). Pri pridávaní testu do už veľkého
  integračného súboru `pnpm lint` VŽDY over PRED pushom, nie až keď to
  spadne v CI.
- **Playwright's `getByLabel`/`getByText` robia SUBSTRING zhodu (case-
  insensitive), nie presnú, pokiaľ nedáš `{ exact: true }`** — nové
  `aria-label` pridané do jednej sekcie môže tichým spôsobom kolidovať s
  `getByLabel(...)` v INOM e2e súbore, ktorý beží na tej istej stránke
  (celá appka je JEDNA stránka, `App.tsx` renderuje `CatalogPage` +
  `OrdersSection` + `SchedulerSection` naraz). Zistené #25: nový
  `aria-label={"Stav riadku " + ...}` na stavovom selecte v
  `OrdersSection.tsx` kolidoval s `catalog.spec.ts`'s
  `getByLabel("Stav")` (katalógov filter) — "strict mode violation:
  resolved to 3 elements". Odhalilo sa AŽ pri behu CELÉHO e2e balíka
  (`pnpm --filter @forestshop/web e2e`), nie len nového spec súboru — pri
  pridávaní `aria-label`/`getByLabel` VŽDY spusti celý balík, nikdy len
  nový spec súbor. **Oprav to na strane KOLÍDUJÚCEHO (existujúceho, užšieho)
  labelu, nie obetovaním prístupnosti nového prvku** — code review na #25
  upozornil, že prvá oprava (odstránenie slova "stav" z nového
  `aria-label`u) by čítačke obrazovky vôbec neoznámila, čo nový select robí.
  Skutočná oprava: existujúci `catalog.spec.ts` dostal
  `getByLabel("Stav", { exact: true })`, nový select v `OrdersSection.tsx`
  si ponechal plnohodnotný popis (`"Zmeniť stav riadku objednávky ..."`).
  novo pridaný test.
- **Rovnaká kolízna trieda ako vyššie platí aj pre ARIA ROLES, nielen
  `aria-label`/`getByLabel` — konkrétne `page.getByRole("alert")` je
  nejednoznačný v CELEJ appke, nielen v jednej sekcii.** #115 pridalo nový
  `<p role="alert">` (staleness upozornenie na "Sync zo Shoptetu", predvolená
  obrazovka po prihlásení) — `login.spec.ts`'s test zmeny hesla (panel v
  hlavičke, viditeľný NAD tou istou predvolenou obrazovkou) mal bare
  `page.getByRole("alert")` a začal padať na "strict mode violation:
  resolved to 2 elements". Rovnaká oprava ako vyššie: `.filter({ hasText:
  "..." })` na strane KOLÍDUJÚCEHO (existujúceho) locatora, nikdy
  odobratím `role="alert"` novému prvku. Test pri KAŽDOM ďalšom
  `role="alert"`/`role="status"` pridanom do zdieľanej obrazovky: spusti
  CELÝ e2e balík (nie len nový spec súbor), presne ako pri `aria-label`
  vyššie.
- **Rovnaká kolízna trieda platí aj pre NOVÚ ZÁLOŽKU v ľavom menu (`nav.ts`)
  — jej tlačidlo je SÚČASŤOU KAŽDEJ stránky appky (Sidebar je vždy
  namountovaný), takže jeho prístupné meno môže substring-om kolidovať s
  `getByRole("button", {...})` v ĽUBOVOĽNOM inom e2e spec súbore, nielen v
  tom, čo novú záložku pridáva.** Issue 240 (nová záložka "Vyhľadať"):
  `page.getByRole("button", { name: "Hľadať" })` v `catalog.spec.ts` (3×,
  existujúci submit button hľadania) začal padať na "strict mode violation
  ... resolved to 2 elements" — `"Vyhľadať"` obsahuje `"Hľadať"` ako
  substring (case-insensitive), presne ako v predošlých nálezoch vyššie.
  Rovnaká oprava (na strane KOLÍDUJÚCEHO existujúceho locatora, nie
  premenovaním novej záložky — jej meno je jej JEDINÝ zmysluplný popis):
  `{ name: "Hľadať", exact: true }`. Test pri KAŽDEJ ďalšej novej záložke v
  `nav.ts`: `grep -rn 'name: "<časť nového label-u>"' apps/web/tests/e2e/`
  (bez `exact: true`) naprieč CELÝM e2e priečinkom, nie len v novo písanom
  spec súbore — spusti aj celý balík (`pnpm --filter @forestshop/web e2e`),
  nikdy len nový súbor.
- **`scripts/e2e-setup.ts` sedí presne NA HRANICI eslint `max-lines: 400`
  (skipBlankLines/skipComments) — pridanie čo i len JEDNÉHO nového importu +
  JEDNÉHO volania `seedXFixtures(...)` (typický vzor pre novú fixtúru
  vyčlenenú do vlastného súboru, viď issue 239/240) ju hneď prehodí cez
  limit, aj keď sprievodný komentár nepočítaš** (komentáre/prázdne riadky
  eslint nepočíta, takže ich skracovanie nepomôže). Fix nie je ďalšie
  vyčleňovanie do súborov (fixtúra je už vyčlenená) — nájdi v súbore
  existujúci viacriadkový `await db.insert(x).values({ ... })` s pár poľami
  a zbaľ ho na JEDEN riadok (dlhé riadky sú v tomto súbore bežné, žiadne
  `max-len` pravidlo nie je aktívne), čím uvoľníš presne toľko riadkov,
  koľko tvoj nový kód pridáva. Over `pnpm lint` PRED pushom, nie až keď
  spadne v CI.
- **`job_run` tabuľka má od #115 JEDEN GLOBÁLNY, natrvalo seedovaný riadok**
  (`scripts/e2e-setup.ts`: umelo zostarnutý úspešný `catalog-import` beh z
  roku 2020) — kvôli `nav.spec.ts`'s staleness testu. Dôsledok: "Sync zo
  Shoptetu"/"Plánovač" NIE SÚ prázdne ako predtým (#22-38) — `login.spec.ts`
  aj `nav.spec.ts` boli upravené, aby to zohľadňovali (`getByTestId("job-
  catalog-import")` namiesto `scheduler-empty`/`sync-history-empty`). Ďalší
  nový e2e test, ktorý by očakával PRÁZDNU `job_run`/históriu behov, treba
  najprv skontrolovať proti tomuto seedu.
- **Playwright s viacerými workermi (predvolený počet, ako aj CI runner)
  môže byť nestály — všetky e2e spec súbory zdieľajú JEDEN bežiaci API
  server aj JEDNU lokálnu Postgres inštanciu.** #32 (vyriešené): koreňová
  príčina NEBOLA rate limiter ani Postgres pool exhaustion (vylúčené
  priamym dôkazom — 9 volaní `/api/login` na celý beh, ďaleko pod
  `MAX_ATTEMPTS=10`, žiadna `429`; všetky requesty 60-160ms), ale
  `login.spec.ts`'s test zmeny hesla, ktorý DOČASNE mení SKUTOČNÉ heslo
  ZDIEĽANÉHO e2e účtu (`e2e@forestshop.sk`) priamo v DB — súbežný
  `POST /api/login` z iného spec súboru (`catalog.spec.ts`/
  `orders.spec.ts`), bežiaci v inom workeri s naprogramovaným pôvodným
  heslom, mohol spadnúť presne do okna medzi zmenou a vrátením hesla a
  dostal skutočný `401`. **Všeobecné pravidlo:** ktorýkoľvek e2e test, čo
  MUTUJE zdieľaný fixture (heslo, rolu, akékoľvek pole zdieľaného riadku),
  ktorý ČÍTAJÚ aj iné súbežne bežiace spec súbory, potrebuje VLASTNÝ
  izolovaný fixture riadok — nie zdieľať účet a spoliehať sa na časovanie.
  Fix: `scripts/e2e-setup.ts` teraz seeduje DRUHÉHO, dedikovaného
  používateľa (`e2e-heslo@forestshop.sk`) len pre `login.spec.ts`'s test
  zmeny hesla — nikto iný sa pod ním neprihlasuje. Vynútenie sériového
  behu (`--workers=1`/`describe.serial`) bolo zámerne zamietnuté ako
  band-aid, ktorý by nechal presne túto mínu pre AKÝKOĽVEK budúci súbežný
  test. Regresný dôkaz:
  `apps/api/tests/e2e-setup-user-isolation.integration.test.ts` (spúšťa
  SKUTOČNÝ `scripts/e2e-setup.ts` ako podproces, overuje izoláciu priamo
  cez `login()`/`changePassword()`, mimo HTTP/rate-limitera).
  **Debug technika pre budúci podobný flake:** `pino` logger tu má default
  level `debug` (`logger.ts`), ale Playwright svojím `webServer`'s stdout
  bežne nezobrazuje — spusti lokálnu reprodukciu s
  `DEBUG=pw:webserver npx playwright test --workers=2`, aby sa JSON logy
  API servera (vrátane `requestId`/`path`/`status`/`elapsedMs` pre KAŽDÝ
  request) prepísali do vlastného výstupu; korelácia timestampov medzi
  zlyhaním a týmito logmi je rýchlejšia cesta k skutočnej príčine než
  hádanie z popisu symptómu.
- **`toContainText`/`toHaveText` na riadku/kontajneri, ktorý obsahuje NATÍVNY
  `<select>`, je tautológia, ak kontrolovaný text zodpovedá jednému z VŽDY
  vykreslených `<option>` popisiek** — všetky možnosti `<select>`u sú v DOM
  strome PRÍTOMNÉ ako deti bez ohľadu na to, ktorá je aktuálne vybraná
  (issue 72, `orders.spec.ts`'s test zmeny stavu). Taká kontrola PREJDE aj
  keď sa zmena nikdy neuloží — nikdy nečaká na skutočné dokončenie async
  zápisu, takže pod pomalším CI behom môže `page.reload()` predbehnúť ešte
  neuzavretý PATCH a NASLEDUJÚCA (skutočná) kontrola po reloade náhodne
  zlyhá. Namiesto kontroly textu okolo selectu vždy over PRIAMO
  `expect(select).toHaveValue("...")` — to skutočne čaká na lokálny
  optimistický update (ktorý nastáva AŽ po vyriešení promisu zápisu), takže
  zaručuje, že zápis je potvrdený PRED ďalším krokom testu (napr. reloadom).
  Pri pridávaní/úprave e2e testu okolo AKÉHOKOĽVEK `<select>`u v tejto appke
  vždy skontroluj, či asercia naozaj testuje VYBRANÚ hodnotu, nie len
  prítomnosť textu niekde v okolí.
- **Rovnaký problém, iný tvar: Playwright's `locator.check()` na kontrolovanom
  (`checked={...}`) checkboxe, ktorého `onChange` spúšťa ASYNC zápis (fetch na
  server), zlyhá s "Clicking the checkbox did not change its state"** —
  `.check()` si SÁM ihneď po kliku overí, že checkbox je zaškrtnutý, ale
  optimistický lokálny update sa prejaví AŽ po vyriešení promisu, takže na
  pomalšom CI behu (nie lokálne) prehrá závod. Zistené issue 60
  (`orders.spec.ts`'s test odškrtávacieho políčka "objednané u dodávateľa" —
  lokálne 100% prešiel, na GitHub Actions runneri spadol na prvom pokuse).
  Fix je rovnaký princíp ako `<select>` vyššie: `.click()` namiesto
  `.check()`/`.uncheck()`, a POTOM `await expect(checkbox).toBeChecked()`
  (alebo `.not.toBeChecked()`) — to SKUTOČNE čaká/opakuje, kým sa zápis
  potvrdí. Pri pridávaní e2e testu okolo AKÉHOKOĽVEK kontrolovaného
  checkboxu v tejto appke použi `.click()` + `expect().toBeChecked()`, nikdy
  `.check()`/`.uncheck()` priamo.
- **`@typescript-eslint/restrict-template-expressions` zakazuje `number` v
  šablónovom literáli** (`` `${count}` `` v `.ts`/`.tsx`, vrátane JSX textu
  zapísaného ako šablóna) — zistené issue 61 (`OrdersToolbar.tsx`'s chip
  popisky "Dodávateľ (N)", `ordersSummary.ts`'s formátovanie súhrnu). Fix je
  `` `${String(pocet)}` ``, nie `eslint-disable` ani presun na obyčajnú JSX
  interpoláciu (`{pocet} ks` mimo šablóny eslint nerieši, ale v komponente s
  viacslovným textom okolo čísla by to vytvorilo viac samostatných text-node
  uzlov s nepredvídateľným whitespace správaním — šablóna + `String()` je
  jednoduchšie aj čitateľnejšie).
- **Nový e2e test do súboru so ZDIEĽANÝMI seedovanými dátami (`scripts/
  e2e-setup.ts`) môže potrebovať konkrétnu POZÍCIU v súbore, nie len
  VLASTNÝ izolovaný účet.** Vlastný účet (vzor vyššie, `E2E_HESLO_ZMENA_
  EMAIL` a ďalšie) rieši LEN rate-limit priestor — dáta (`order`/`order_
  line`/`order_open_status`) sú GLOBÁLNE, zdieľané naprieč VŠETKÝMI účtami
  v tom istom súbore, a testy v jednom súbore bežia sekvenčne (jeden
  worker na súbor). Issue 61 (`orders.spec.ts`) potreboval overiť PÔVODNÉ,
  ešte-nezmutované seedované dáta (DODAVATEL-TEST-1 v "caka_sa",
  "(bez dodávateľa)" v predvolenom "objednane") — namiesto pridávania
  DALŠÍCH riadkov/dodávateľov (čo by rozbilo existujúce testy, ktoré
  spoliehajú na PRESNÝ počet riadkov danej skupiny, napr. "DODAVATEL-
  TEST-1 má vždy presne 1 riadok") bol nový test vložený ako PRVÝ v súbore,
  PRED testami, ktoré stav/`ordered`/`order_open_status` mutujú. Pri
  ďalšom teste, ktorý potrebuje pôvodné dáta, zváž POZÍCIU v súbore skôr
  než pridávanie nových fixtúrových riadkov k existujúcemu dodávateľovi.
- **Test, ktorý potrebuje DVA riadky s TÝM ISTÝM `variantCode` v jednej
  skupine dodávateľa (issue 62 — súčtový chip), nesmie ich pridať do
  `DODAVATEL-TEST-1` ani `(bez dodávateľa)`** — `orders.spec.ts`'s úplne
  prvý test (`E2E_FILTRE_EMAIL`) overuje PRESNÝ globálny počet riadkov
  ("Všetci (N)", "Ostáva vybaviť X z N") naprieč VŠETKÝMI dodávateľmi, takže
  pridanie čohokoľvek k existujúcej skupine ho ticho rozbije. Riešenie: NOVÁ,
  dovtedy nepoužitá skupina dodávateľa — vezmi jeden nepoužívaný fixtúrový
  variant (grep, že jeho kód sa nikde netestuje, `.claude/rules/catalog.md`'s
  CSV-editačný vzor vyššie) a daj mu vo fixtúre nový `supplier` reťazec.
  Global count assertions v prvom teste treba ZVÝŠIŤ presne o toľko nových
  riadkov, koľko pridáš (a o zodpovedajúci "ostáva vybaviť"/bucket rozdiel,
  podľa toho, v akom stave nové riadky sú) — spočítaj to explicitne, nehádaj.
  Ako pri predchádzajúcom bode: nová skupina potrebuje aj VLASTNÝ izolovaný
  e2e účet (balík je na hranici `MAX_ATTEMPTS=10`), nikdy ďalšie prihlásenie
  pod zdieľaným `e2e@forestshop.sk`.
- **`options.field ?? "predvolená hodnota"` v testovom helperi TICHO
  ignoruje výslovne zadané `field: null`** — `??` fallbackuje na `null` AJ
  `undefined` rovnako, takže volajúci, ktorý chce SKUTOČNÉ `null` (nie len
  "nezadal som to"), dostane predvolenú hodnotu namiesto neho. Zistené
  issue 63 (`tests/helpers/orders.ts`'s `insertTestVariantForProduct`,
  `supplier: options.supplier ?? "Test dodávateľ"` — žiadny existujúci test
  dovtedy nepotreboval zdieľaný produkt BEZ dodávateľa, takže sa to
  neprejavilo skôr). Fix: `"pole" in options ? options.pole :
  predvolená` — rozlíši "kľúč vôbec nezadaný" od "zadané ako null".
  Rovnaký test pri KAŽDOM ďalšom helperi s `nullable` voliteľným poľom a
  `??` defaultom: potrebuje niekedy volajúci vynútiť `null` PROTI
  defaultu? Ak áno, `??` to nedovolí.
- **Wide inline obsah (vstup + tlačidlo) v úzkom `<td>` bez zalomenia
  (`white-space: nowrap`) môže VIZUÁLNE pretiecť do SUSEDNÉHO stĺpca a
  ukradnúť Playwright kliky mierené na prvok v ňom** — `locator.click()`
  padá opakovane na "`<iný prvok>` ... intercepts pointer events" (nie
  flaka, deterministicky, kým sa CSS neopraví). Zistené issue 63
  (`.ord-supplier-assign` stĺpec — vstup 140px + tlačidlo pri `nowrap`
  pretiekli do susedného stĺpca "Stav", ktorého `<select>` (neskôr v DOM-e,
  teda navrchu) potom kradol kliky na tlačidlo pod ním). Fix: `display:
  flex; flex-wrap: wrap` na bunke namiesto `white-space: nowrap` — obsah sa
  zalomí VNÚTRI bunky (rastie výška riadku), nikdy nepretečie do
  suseda. Rovnaký test pri KAŽDOM ďalšom stĺpci s viacerými inline
  ovládacími prvkami v jednej `<td>`: over reálnym Playwright behom (nie
  len vizuálne v prehliadači na širokej obrazovke), že klik na KAŽDÝ prvok
  skutočne trafí TEN prvok, nie souseda pod ním po pretečení.
- **`apps/web/tests/e2e/*.ts` malo (do issue 95) žiadny VLASTNÝ
  `tsconfig.json` — spoliehalo sa na `eslint.config.js`'s
  `allowDefaultProject` fallback na `apps/api/tsconfig.eslint.json`
  (Node-only `lib: ["ES2023"]`, žiadne DOM).** Kým e2e testy volali len
  Playwright's vlastné (už typované) API (`page.click`, `expect`, …), to
  nevadilo. Prvý test, čo volá `page.evaluate(() => document.body...)` (issue
  95: kontrola `document.body.scrollWidth`/`window.innerWidth` proti
  vodorovnému posúvaniu stránky), zlyhal na type-aware lint ("unsafe member
  access .body on a type that cannot be resolved") — `document`/`window` v
  callbacku nemali odkiaľ dostať typ. Fix: vlastný
  `apps/web/tests/e2e/tsconfig.json` (rovnaký vzor ako
  `apps/api/tests/tsconfig.json`/`scripts/tsconfig.json`, `.claude/rules/
  local-dev.md`), navyše s `"lib": ["ES2023", "DOM"]`, pridaný do root
  `typecheck` skriptu; `eslint.config.js`'s `allowDefaultProject` zoznam
  stratil svoj `"apps/web/tests/e2e/*.ts"` riadok (project service si nový
  reálny tsconfig nájde sám — rovnaký dôvod ako existujúce dva odstránené
  riadky vedľa neho). Test na KAŽDÝ ďalší `page.evaluate()`/browser-context
  kód v novom e2e súbore: over, či tento tsconfig existuje a má `DOM` v
  `lib` — bez neho type-aware lint padne na prvom odkaze na
  `document`/`window`/`navigator` vnútri callbacku.
- **`"lib": ["ES2023", "DOM"]` v `apps/web/tests/e2e/tsconfig.json` (bod
  vyššie) NESTAČÍ na `[...nodeList]` spread cez viacero prvkov** — issue 105
  (kontrola pretekania KAŽDEJ `<th>` cez `[...document.querySelectorAll(...)]`
  v `page.evaluate()`) narazila na `TS2488: Type 'NodeListOf<...>' must have a
  '[Symbol.iterator]()' method`. `NodeListOf`'s iterátor žije v samostatnej
  `DOM.Iterable` lib-e, nie v `DOM` — pridaj `"DOM.Iterable"` do `lib` poľa
  hneď vedľa `"DOM"`. Test na KAŽDÝ ďalší e2e `page.evaluate()` kód, ktorý
  spreadne/iteruje `querySelectorAll`/`getElementsByClassName` výsledok
  (`[...xs]`, `for...of`): over, že tsconfig má aj `DOM.Iterable`, nielen `DOM`.
- **Fixtúrový variant pre nový e2e test PRODUKTOVO-kľúčovaného override
  (`product_supplier_override`, `product_supplier_link_override`) sa nesmie
  vybrať len podľa "je nepoužitý v `orders.spec.ts`" — musí sa overiť aj, či
  na NEJAKOM SÚRODENECKOM variante (rovnaký `productKey`) INÝ test hard-
  coduje presnú hodnotu (napr. `href`).** Issue 121 (manuálny odkaz na
  dodávateľa): kandidát `"4859/48"` mal reálny fixtúrový `internalNote`
  odkaz vhodný na test "upraviť EXISTUJÚCI odkaz zo Shoptetu" — ale `"4859/
  48"` je súrodenec `"4859/46"`, ktorého PRESNÚ `href` hodnotu
  `orders.spec.ts`'s prvý mailový/odkazový test hard-coduje
  (`"https://www.huntingshop.eu/wild-t-green-nohavice"`). Keďže override je
  kľúčovaný `productKey`, nie `variantCode`, prepísanie odkazu cez
  `"4859/48"` by zmenilo EFEKTÍVNU hodnotu aj pre `"4859/46"` a ticho rozbilo
  ten vzdialený test. Fix: použiť ÚPLNE INÝ, dovtedy nepoužitý JEDNOVARIANTNÝ
  produkt (`"278"`) namiesto súrodenca už-testovaného produktu, a namiesto
  testovania "upraviť EXISTUJÚCI Shoptet odkaz" cez reálne fixtúrové dáta
  otestovať rovnaké správanie cez VLASTNÝ, práve uložený override (doplniť →
  upraviť VLASTNÚ hodnotu) — rovnako platný dôkaz "upraviť" cesty, bez
  rizika medzi-testovej kolízie. Pri KAŽDOM ďalšom produktovo-kľúčovanom
  override teste: `grep` cieľový `productKey` (nie len `variantCode`) naprieč
  CELÝM `apps/web/tests/e2e/` predtým, než ho použiješ.
- **E2E test, ktorý potrebuje simulovať ZLYHANÝ zápis na server (výpadok
  siete, 5xx), MUSÍ prepichnúť `window.fetch` cez `addInitScript` — NIKDY
  `page.route().abort()`/`.fulfill({status: 4xx/5xx})`.** Issue 66
  (kumulatívny banner o neuložených zmenách): `page.route` ide cez
  SKUTOČNÚ sieťovú vrstvu prehliadača, takže Chromium zaloguje reálne
  "Failed to load resource" do konzoly — presne to, čo vyššie uvedený
  zákaz rozširovania JEDINEJ povolenej konzolovej výnimky (401 na
  `/api/me`) zakazuje. Naživo overené (Playwright MCP proti produkcii aj v
  tomto e2e súbore): prepichnutý `window.fetch` (JS-level override, nikdy
  sa nedotkne skutočnej siete pre zhodné URL) pri REJECTNUTÍ aj pri fake
  200 `Response` vracia NULOVÉ console správy. Vzor (`orders-write-
  failures.spec.ts`): `addInitScript` nahradí `window.fetch` funkciou, čo
  pre NE-GET požiadavky na URL fragmenty v `Set`e buď rejectne
  (`Promise.reject(new TypeError(...))` — simuluje výpadok siete) alebo
  vráti fake `new Response(...)` (simuluje úspech BEZ reálneho zápisu),
  inak zavolá originálny `fetch`. Musí bežať `addInitScript`om (pred
  KAŽDÝM appkovým skriptom), nie neskorším `page.evaluate` — appka volá
  zápisové funkcie hneď pri mounte/interakcii. Bonus: keďže reálny zápis
  nikdy neodíde na server, test nepotrebuje VLASTNÚ fixtúrovú objednávku
  ani obavu o kolíziu s inými spec súbormi bežiacimi súbežne — smie
  bezpečne použiť UŽ existujúce fixtúrové riadky (napr. `orders.spec.ts`'s
  DODAVATEL-TEST-1/"(bez dodávateľa)" riadky).
- **Changing an existing form element's TAG (e.g. `<input>` → `<textarea>`,
  issue 150's multi-line comment) silently breaks any e2e test that
  queries it with a TAG-SCOPED selector, even though `data-testid`/
  `aria-label` are unchanged.** `orders-layout.spec.ts`'s row-height check
  used `document.querySelector<HTMLInputElement>('input[data-testid^=
  "comment-input-"]')` — after the tag change this silently returned
  `null` (not a type error, since `querySelector` always types-as-cast),
  so a DOWNSTREAM property read on `undefined` failed with a confusing
  "expected true, got undefined" instead of "element not found". Local
  full e2e run caught it (CI would have too) — the fix is to drop the tag
  from the selector (`'[data-testid^="comment-input-"]'`) so it survives
  future tag changes on the same element. Any FUTURE element-tag change
  (input↔textarea↔select) needs a `grep -rn '<oldtag>\[data-testid'
  apps/web/tests/e2e/` across the WHOLE e2e directory, not just the spec
  file that already covers the element's own behaviour.
- **A `<textarea>`'s Enter-vs-Ctrl+Enter split needs REAL keystrokes in
  both vitest (`fireEvent.keyDown(el, {key:"Enter", ctrlKey:true})`) and
  Playwright (`locator.press("Control+Enter")`), never `.fill()`/
  `fireEvent.change()` alone** — issue 150: `.fill()` only sets the DOM
  `.value` and fires a synthetic `input`/`change` event, it never
  dispatches a `keydown`, so a test using only `.fill()` would pass
  whether the Enter-vs-Ctrl+Enter branching logic was implemented
  correctly OR removed entirely. `pressSequentially`/`.press()`
  (Playwright) and `fireEvent.keyDown` (vitest) are the only two APIs that
  actually exercise the `onKeyDown` handler being tested.
- **A NEW e2e assertion that reads a value from a shared SINGLETON DB row
  (e.g. `posta_uncollected_settings`/`order_reminder_settings`'s `enabled`
  flag) must NOT hardcode the value if a DIFFERENT spec file toggles that
  same row.** Issue 185 (`nav.spec.ts`): a new assertion asserted the nav
  status pill shows exactly `"Zastavené"`, matching the seeded default —
  but `posta-uncollected.spec.ts`/`order-reminder.spec.ts` toggle that
  SAME global singleton row on then off again mid-test (self-cleaning at
  the end, but genuinely `enabled: true` for a window in the middle), and
  Playwright runs spec FILES across 2 concurrent workers (`Running N tests
  using 2 workers` in the local run). A hardcoded exact-value assertion on
  such a row is a latent flake — found and fixed by self-review, not by an
  observed failure (the one local run happened to pass). Fix: assert a
  REGEX of valid states (`toHaveText(/^(Zastavené|Beží)$/)`) instead of the
  exact expected value — the SAME discipline `nav.spec.ts` already applies
  to `nav-badge-orders`'s count (`toHaveText(/^\d+$/)`) for the identical
  reason (shared, concurrently-mutable state). Test on any FUTURE
  assertion added to one spec file that reads a value another spec file
  mutates: does the OTHER file toggle/mutate this same row mid-test? If
  yes, assert "a valid value", never the specific one.
- **Konzolová výnimka na `/api/me` 401 UŽ NEEXISTUJE a nesmie sa vrátiť
  (issue 188).** Endpoint od `0.3.0-dev.112` vracia neprihlásenému **200 s
  telom `null`**, nie 401 — práve preto, že Chromium loguje KAŽDÚ 4xx
  odpoveď do konzoly ako chybu, takže úplne zdravá appka vypisovala červenú
  chybu na prihlasovacej obrazovke. Všetkých 13 e2e spec súborov teraz
  overuje PRÁZDNU konzolu bez jedinej výnimky (filter `jeOcakavane` je
  odstránený). Nová konzolová chyba sa preto rieši VÝHRADNE v appke, nikdy
  pridaním filtra do testu — a nový endpoint, ktorého bežný očakávaný
  doménový výsledok je „nič"/neúspech, vracia 200 s telom (vzor `/api/me` a
  `POST /api/me/password`), nie 4xx.
- **Integračný test, ktorý ide cez skutočnú HTTP trasu (nie priamo cez
  funkciu s explicitným `now` parametrom) a vkladá fixtúrové dáta s PEVNÝM
  dátumovým LITERÁLOM ako "dnes"/"tento týždeň", je časovaná bomba — spadne
  presne v deň, keď skutočný kalendárny dátum prekročí ten literál.**
  Zistené issue 239 (`orders-overview.integration.test.ts`): jediný test v
  súbore, ktorý NEPOSIELA `NOW` priamo do `getOrdersDashboardOverview` (na
  rozdiel od ostatných testov v tom istom súbore), ale ide cez
  `GET /api/orders/overview`, ktorá si "dnes" počíta zo SKUTOČNÉHO
  `new Date()` na serveri — vkladal fixtúru s `TODAY_START` pevne
  `2026-08-03/04`. Test prešiel mesiace, kým vývoj tohto ticketu (2026-08-04
  → 2026-08-05) skutočne neprekročil polnoc a test spadol so zdanlivo
  nesúvisiacou chybou (`orderCount: 0` namiesto `1`). Fix: hranica sa
  prepočíta PRI BEHU testu cez existujúcu `computeOrdersDashboardBoundaries
  (new Date())` (tá istá funkcia, akú používa aj samotná trasa — premenovaná
  z `computeBratislavaPeriodBoundaries` v issue 407, viď `.claude/rules/
  orders.md`), nie
  literál napísaný v deň písania testu. **Test na KAŽDÝ ďalší
  "dnes/týždeň/mesiac" integračný test, čo ide cez HTTP trasu (nie priamo
  cez funkciu s explicitným `now`):** vkladá fixtúru s PEVNÝM dátumovým
  literálom? Ak áno, a testovaná trasa/funkcia si "teraz" berie sama zo
  systémového hodín, prepočítaj hranicu pri behu testu namiesto písania
  literálu — inak test raz, nevyhnutne, prestane platiť.
- **Čakanie pridané DO e2e testu (napr. `await expect(prvok).toBeHidden()`)
  môže test spraviť zeleným zo ZLÉHO dôvodu — zaručí bezpečné poradie
  udalostí bez ohľadu na to, či je race v komponente skutočne opravený.**
  Issue 251 (`supplier-links.spec.ts`): pôvodná verzia testu mala
  `await expect(vstup).toBeHidden()` PRED prepnutím filtra — to zaručilo,
  že `.then()`'s `refetch()` (a teda aj jeho `searchSeq`) prebehne SKÔR, než
  test prepne filter, takže test prešiel AJ keby bola oprava komponentu
  vrátená naspäť (empiricky overené: s vráteným produkčným fixom test s
  týmto čakaním prešiel 4/4). Fix nie je len odstránenie čakania — je
  **overenie testovej rozlišovacej sily**: po KAŽDEJ oprave race/timing bugu
  dočasne vráť produkčný fix naspäť a potvrď, že test SPADNE (tu: 3/3
  nezávislé behy zlyhali s presne nahláseným symptómom, keď bol fix
  vrátený, a 6/6 prešlo s hotovým kódom). Samotný zelený beh nič
  nedokazuje o tom, či test race skutočne testuje.
- **Reprodukčná technika pre save-then-refetch/stale-closure race:
  prepichnutý `window.fetch` cez `addInitScript`, ktorý REÁLNU odpoveď (nie
  fake/mock) oneskorí o ~400ms, plus OPAKOVANÉ nezávislé behy s čerstvým DB
  reseedom + reštartom API medzi nimi.** Issue 251 (rovnaký vzor ako
  `orders-write-failures.spec.ts`, pozri jeho `addInitScript` blok vyššie v
  tomto súbore — tu ale REÁLNA odpoveď je len oneskorená (`setTimeout` vo
  wrapperi okolo `puvodny(...)`), nie reject/fake-response): oneskorenie
  SKUTOČNEJ odpovede je nutné, lebo test musí overiť, ktorý REÁLNY výsledok
  (aktuálny vs. zastaraný filter) `refetch()` skutočne zapíše — fake
  response by netestovala nič o tom, čo server vrátil. Jeden zelený beh
  nestačí na potvrdenie/vyvrátenie race fixu (flaky failure sa môže minúť)
  — potrebné je NIEKOĽKO NEZÁVISLÝCH behov, každý s čerstvým DB reseedom
  (`scripts/e2e-setup.ts`) a reštartom API servera, nie opakovanie v tom
  istom procese/stave.
- **Súbežne bežiace/zabudnuté `pnpm --filter @forestshop/api test:integration`
  procesy (napr. z predošlého overovania, ktoré agent zabudol počkať/
  zabiť) spôsobia SKUTOČNÉ zlyhania v INÝCH testoch — nie len pomalší
  beh.** Issue 267 follow-up: paralelný beh nechal 19 testov v
  `restock-run.integration.test.ts` padnúť na `Error: Hook timed out in
  10000ms` (v `beforeEach`'s `withCleanDb()`) a `db-isolation-lock
  .integration.test.ts` na `TypeError: close is not a function` — vyzeralo
  to ako regresia z aktuálnej zmeny, no príčinou bol vyčerpaný Postgres
  connection pool/súperenie o zdieľanú lokálnu DB medzi DVOMA súčasne
  bežiacimi `vitest run tests` procesmi (`.claude/rules/testing.md`'s
  vlastný advisory-zámok popis rieši len TRUNCATE-kolíziu, nie všeobecné
  vyčerpanie zdrojov pri plnom paralelnom behu celej sady). Fresh beh PO
  `ps aux | grep vitest` (a `kill -9` akéhokoľvek nájdeného osirelého
  procesu z predošlého overovania) prešiel 69/69 súborov, 518/518 testov
  čisto. Pred DÔVEROVANÍM červenému `test:integration` výsledku vždy over
  `ps aux | grep vitest`, či nebeží iný súbežný beh — najmä po tom, čo
  agent spustil viac `run_in_background` testovacích príkazov v tej istej
  relácii bez čakania na ich skutočné dokončenie.
- **Rovnaký symptóm (`Hook timed out in 10000ms` v `restock-run
  .integration.test.ts`, aj Playwright e2e `Test timeout of 30000ms
  exceeded` v ÚPLNE INÝCH, nesúvisiacich spec súboroch) sa dá vyrobiť AJ
  BEZ druhého `vitest`/e2e procesu — stačí, že `dev1` je zaťažený INÝMI
  súbežnými Claude reláciami/procesmi.** Issue 283: `ps aux | grep vitest`
  bol čistý (žiadny osirelý test proces), ale `uptime` ukázal load average
  ~14-17 (5+ súbežných `claude` relácií + `pytest` behy + GitHub Actions
  runner na tom istom boxe) — 19/19 testov v `restock-run.integration
  .test.ts` aj viacero NESÚVISIACICH e2e testov (`orders.spec.ts`,
  `pairing.spec.ts`, `orders-supplier-link.spec.ts`) padlo na timeout v
  JEDNOM behu, potom prešlo 100% pri izolovanom re-behu TOHO ISTÉHO
  súboru bez zmeny kódu. Test pred DÔVEROVANÍM červenému výsledku:
  `ps aux | grep vitest` NESTAČÍ samo osebe — over AJ `uptime` (vysoký
  load average bez zjavného vlastného vitest/pytest procesu) a pri
  podozrení preveruj IZOLOVANÝM re-behom PRESNE toho zlyhaného
  súboru/testu (`vitest run tests/<súbor>` / `playwright test
  tests/e2e/<súbor>`), nikdy nepredpokladaj regresiu len z jedného
  červeného plného behu na zdieľanom, vyťaženom boxe.
- **Rovnaká trieda vyššie (preťažený zdieľaný box) má aj tichší tvar bez
  akéhokoľvek testovacieho výstupu** — `pnpm --filter @forestshop/web e2e`
  spadlo hneď na `Error: Timed out waiting 60000ms from config.webServer.`
  (issues 287/288), teda PRED spustením čo i len jedného testu; oba
  `webServer` procesy (`e2e-setup.ts` + `tsx src/index.ts`) sa nestihli
  zdvihnúť do 60 s po ~9-minútovom integračnom behu na tom istom
  vyťaženom boxe. Manuálne spustenie `pnpm exec tsx scripts/e2e-setup.ts`
  z KOREŇA repa (nie z `apps/web` s relatívnou cestou `../../scripts/...`)
  potvrdilo, že skript sám funguje (0 exit, reálne logy) — problém bol
  čisto o čase na vyťaženom boxe, nie o rozbitom skripte/ceste. Fix: ŽIADNA
  zmena kódu, len opakovanie `pnpm --filter @forestshop/web e2e` prešlo
  načisto (46/46). Pri `Timed out waiting Nms from config.webServer` bez
  akéhokoľvek ďalšieho výstupu skús izolovaný re-beh AKO PRVÉ, nie
  predlžovanie timeoutu (`no-timeout-band-aids.md`) ani hľadanie bugu v
  `e2e-setup.ts`/`playwright.config.ts`.
- **Komponentové testy (`apps/web/src/components/*.test.tsx`) NEMAJÚ
  `@testing-library/jest-dom` matchery — `expect(el).toHaveAttribute(...)`
  padne na `tsc` s "Property 'toHaveAttribute' does not exist"** (issue
  345, živo nájdené). Repo dôsledne používa holé vitest/RTL API:
  `expect(el.getAttribute("href")).toBe(...)` namiesto jest-dom matcherov
  (`toHaveAttribute`/`toBeVisible`/`toBeInTheDocument`) — over existujúci
  sesterský test (napr. `NedostupneSection.test.tsx`) pred písaním nového,
  nikdy nepredpokladaj, že jest-dom je nainštalovaný.
- **Playwright's `.filter({ hasText })` re-vyhodnocuje sa PRI KAŽDOM ĎALŠOM
  použití locatora — ak akcia PREPÍŠE riadok tak, že jeho pôvodný text už
  NIE JE textovým uzlom (napr. inline-edit prepne `<span>text</span>` na
  `<input value="text">`), ten istý `hasText` filter prestane nachádzať
  ČOKOĽVEK a ďalší krok (`.locator("input")` na ňom) timeoutne bez chyby o
  tom, PREČO.** Issue 342 (`daily-tasks.spec.ts`): `<input>`'s `value`
  atribút sa NEPOČÍTA do textového obsahu, na rozdiel od `<span>`. Fix pre
  KROKY vnútri takto prepísaného stavu: nájsť vstup/tlačidlo GLOBÁLNE cez
  jeho PEVNÝ (nie per-riadok interpolovaný) `aria-label`/CSS triedu, bezpečné
  len keď appka dovolí najviac JEDEN riadok v tomto stave naraz (over to v
  komponente pred spoliehaním sa naň). Pred/po tomto prepnutí (keď text
  OSTÁVA viditeľný ako `<span>`) `hasText` funguje ďalej bez problémov —
  past sa týka LEN krokov PROBIEHAJÚCICH počas prepnutia.
- **`withCleanDb()`'s advisory zámok (`TEST_DB_ISOLATION_LOCK_KEY`) sa môže
  natrvalo ZASEKNÚŤ, keď ho držiaci klient nikdy nezavolá `close()`
  (zomrelý/killnutý proces, nie len preťažený box) — výsledný symptóm je
  RASTÚCA fronta `pg_advisory_lock` čakateľov (jeden pribudne pri KAŽDOM
  ĎALŠOM súbore vitestu, ~30s odstup = `testTimeout`), nie len pomalý beh.**
  Issue 342: plný `test:integration` beh (predtým spustený a KILLNUTÝ inak,
  nie `Ctrl+C`/graceful) nechal PRVÉHO držiteľa zámku v stave `idle`
  (`pg_stat_activity`), takže KAŽDÝ ĎALŠÍ súbor v novom behu čakal navždy.
  Diagnostika: `docker exec <postgres-kontajner> psql -U forestshop -d
  forestshop -c "select pid, state, wait_event_type, query_start, left
  (query,60) from pg_stat_activity where datname='forestshop' order by
  query_start;"` — prvý riadok v stave `idle` s dávno starým `query_start`
  DRŽÍ zámok, zvyšok ČAKÁ naň. Fix: `pg_terminate_backend(<ten prvý pid>)`
  (bezpečné na LOKÁLNEJ dev DB, nikdy na produkcii), potom `ps aux | grep
  vitest` + `kill -9` na osirelé OS procesy, potom nový beh. Príznak, čo to
  odlišuje od bežného "preťažený box" (vyššie v tomto súbore): ten sa
  prejaví POMALOSŤOU/timeoutmi na NÁHODNÝCH testoch, toto sa prejaví
  ÚPLNÝM zamrznutím KAŽDÉHO ĎALŠIEHO integračného súboru bez jediného
  riadku výstupu, kým sa nezabije držiaci proces.
- **Jeden `it()`, ktorý reťazí VIAC sekvenčných UI scenárov (viac `waitFor`
  volaní za sebou) v JEDNOM zdieľanom `testTimeout` (predvolene 5000ms), je
  flaky POD ZÁŤAŽOU (veľa súborov bežiacich súbežne cez vitest thread pool)
  aj keď je komponent sám rýchly.** Issue 365
  (`OrdersSection.writeFailures.test.tsx`): izolovane 345-388ms (13-14×
  rezerva), no pod záťažou (viac `claude`/CI procesov na tom istom boxe)
  padal na `Test timed out in 5000ms` — nie regresia, len 5 `waitFor`
  volaní zdieľajúcich JEDEN 5000ms strop namiesto vlastného pre každé.
  **Fix je VŽDY rozdeliť na samostatné `it()` bloky (každý dostane VLASTNÝ
  5000ms rozpočet), nikdy zvýšiť `testTimeout`** (`no-timeout-band-aids.md`
  — timeout nie je príčina, len symptóm zdieľaného rozpočtu). Vzor:
  spoločné nastavenie (render + kroky, ktoré vytvoria stav potrebný pre
  VIAC nasledujúcich testov) sa vytiahne do malého lokálneho `async`
  helpera volaného na začiatku KAŽDÉHO nového testu — žiadna asercia sa pri
  rozdelení nesmie vynechať, len sa presunie do testu, ktorého scenár
  overuje. Test na KAŽDÝ ĎALŠÍ nahlásený "flaky, timeoutuje pod záťažou,
  ale prechádza izolovane" nález v tomto repe: najprv over izolovaný beh
  (potvrdí/vyvráti, že komponent je naozaj rýchly), potom hľadaj v súbore
  JEDEN `it()` s viacerými `waitFor` volaniami — to je takmer vždy skutočná
  príčina, nie testovacie prostredie.
- **`pnpm --filter @forestshop/web e2e -- <súbor1> <súbor2>` NEFILTRUJE na
  tie súbory — spustí CELÚ e2e sadu.** `package.json`'s `"e2e": "playwright
  test"` skript už je len 2 slová; pnpm-ov vlastný `--` pred argumentmi PRE
  skript sa cez `pnpm --filter X e2e --` odovzdá do PRÍKAZU AKO DOSLOVNÝ
  ĎALŠÍ ARGUMENT (`playwright test "--" "<súbor1>" "<súbor2>"`), nie ako
  oddeľovač, ktorý pnpm sám skonzumuje — Playwright potom dostane `--` ako
  neplatný prvý filter, čo v praxi znamená "žiadny filter", takže beží
  úplne všetko (issue 387 E6, naživo overené: namiesto 2 zadaných spec
  súborov sa spustilo 61 testov naprieč celým `tests/e2e/`, vrátane
  nesúvisiaceho `catalog.spec.ts`). **Funkčný spôsob, ako lokálne spustiť
  LEN vybrané spec súbory:** obísť `package.json`'s `e2e` skript úplne,
  volať `playwright` priamo cez `pnpm --filter @forestshop/web exec
  playwright test tests/e2e/<súbor1>.spec.ts tests/e2e/<súbor2>.spec.ts`
  (`exec`, nie samotný skript-alias) — `webServer`'s `reuseExistingServer:
  false` (`playwright.config.ts`) navyše znamená, že KAŽDÉ takéto
  spustenie reseeduje appku odznova (nikdy nezdieľa už bežiaci server z
  predošlého volania), takže postupné volania sú vzájomne bezpečné.
  **Ten istý príkaz navyše potrebuje `DATABASE_URL` NASTAVENÉ v
  spúšťajúcom shelli** (`DATABASE_URL=postgres://forestshop:forestshop
  @127.0.0.1:5433/forestshop pnpm --filter @forestshop/web exec playwright
  test ...`) — `playwright.config.ts`'s `webServer` (`e2e-setup.ts` +
  `api start`) žiadnu predvolenú hodnotu NEMÁ, na rozdiel od CI (kde ju
  GitHub Actions-ov Postgres service kontajner nastavuje automaticky);
  bez nej appka's `env.ts` zhodí `webServer` proces hneď pri štarte
  ("Chybná konfigurácia prostredia... DATABASE_URL... Required"), a
  Playwright to nahlási len ako všeobecné "Process from config.webServer
  was not able to start" bez zjavnej príčiny v prvom riadku výstupu — nie
  je to samostatná, dovtedy nezdokumentovaná medzera (líši sa od "Live
  pixel meranie" vzoru v `.claude/rules/local-dev.md`, ktorý rieši
  `db:migrate`/`api start` priamo, nie `pnpm ... e2e`'s vlastný webServer
  subproces).
- **Odstránenie CELEJ OBRAZOVKY (nie len stĺpca/triedy) potrebuje grep
  CELÉHO `apps/web/tests/e2e/` na jej `nav-tab-<id>`/testid-y — nielen
  kontrolu, ktoré MODULY z nej importujú.** Issue 400 (odstránenie
  "Párovanie produktov", #239): žiadny INÝ komponent ju neimportoval, ale
  `pairing-review.spec.ts` (úplne INÝ, nesúvisiaci spec súbor) mal vlastný
  test, ktorý PO uložení rozhodnutia klikol `nav-tab-supplier-links` a
  overil hodnotu na odstraňovanej obrazovke — ako KRÍŽOVÝ dôkaz, že
  zdieľané zápisové jadro (`upsertProductSupplierLink`) naozaj zapisuje do
  tej istej tabuľky, čo číta INÁ obrazovka. Takýto test NEPADNE na
  `grep -rn "SupplierLinksSection"` (nič z neho neimportuje), len na
  skutočnom BEHU e2e balíka. Fix: prerobiť krížové overenie cez INÚ
  ŽIJÚCU obrazovku so zdieľanou zápisovou cestou (tu: "Vyhľadať", #240) —
  nikdy len vymazať test/asserciu. Test na KAŽDÉ ĎALŠIE odstránenie celej
  obrazovky v tomto repe: `grep -rn "nav-tab-<id>\|<jej-testid-prefix>"
  apps/web/tests/e2e/` naprieč CELÝM priečinkom (nielen jej vlastný spec
  súbor), PRED zmazaním — presne ako `.claude/rules/pairing-search.md`'s
  E8 sekcia dokumentuje pre `git diff` dôkaz na strane API/modulov, tu ten
  istý princíp na strane e2e krížových testov.
- **RED-pred-GREEN dôkaz pre bug-fix, čo v JEDNOM edite zároveň
  PREMENUJE a MENÍ SPRÁVANIE existujúcej funkcie (žiadny prirodzený "starý
  test/nová funkcia" rozdiel): dočasne VRÁŤ len implementačné súbory na
  `git show HEAD:<súbor> > <súbor>`, nechaj NOVÉ testové súbory v pracovnom
  strome, spusti ich a potvrď zlyhanie, potom implementáciu vráť späť.**
  Issue 407 (`overview.ts`'s `computeBratislavaPeriodBoundaries` →
  `computeOrdersDashboardBoundaries`, kalendárne → kĺzavé okná): keďže
  testy aj implementácia boli upravené v tom istom pracovnom kroku, nešlo
  jednoducho "spustiť staré testy proti novej implementácii" — dočasné
  obnovenie STARÝCH `overview.ts`/`timezone.ts` súborov (zo `HEAD`) pri
  ponechaní NOVÝCH testov ukázalo skutočné zlyhanie (8/15 unit testov,
  `TypeError` na premenovanej funkcii + zvyšné testy by zlyhali na
  logike), čím sa RED reálne overil (nie len predpokladal) predtým, než sa
  fix commitol ako samostatný GREEN commit za ním. Rovnaký postup pre
  KAŽDÝ ĎALŠÍ bug-fix v tomto repe, kde sa test aj implementácia menia v
  jednom priechode: `cp <súbor> <scratch>` (záloha opravenej verzie),
  `git show HEAD:<súbor> > <súbor>` (dočasný revert), spusti dotknuté
  testy → potvrď RED, `cp <scratch> <súbor>` (obnov fix) → potvrď GREEN,
  commituj testy a implementáciu ako DVA samostatné commity v tomto
  poradí.
- **Nový `externalOrderId` v e2e seede musí byť voľný naprieč `scripts/e2e-setup.ts`
  AJ VŠETKÝMI `scripts/e2e-fixtures-*.ts` — objednávkové id sa seedujú z viacerých
  súborov, nielen z `e2e-setup.ts`.** Issue 443 (stálo to DVA CI cykly): pridal
  som druhú nedostupnú objednávku a vybral `9009` (grepnutý ako voľný LEN v
  `e2e-setup.ts`) — kolidoval s existujúcou objednávkou v `e2e-setup.ts` samotnom;
  potom `9012` — kolidoval s `scripts/e2e-fixtures-dpd.ts`'s `seedDpdFixtures`.
  `e2e-setup.ts` volá ~8 `seed*Fixtures(...)` z oddelených súborov, každý seeduje
  do TEJ ISTEJ DB, takže `order.external_order_id` unique constraint platí naprieč
  nimi všetkými. Duplicita nezhodí test asertom — zhodí **e2e webServer pri
  štarte**: `e2e-setup.ts` hodí `duplicate key value violates unique constraint
  "order_external_order_id_unique"` (exit 1) a Playwright to hlási len ako
  všeobecné `Error: Process from config.webServer was not able to start. Exit
  code: 1` → padnú VŠETKY e2e testy, nielen ten dotknutý. **Pred pridaním
  objednávky grepni VŠETKY seed súbory naraz:** `grep -rhoE 'externalOrderId:
  "[0-9]+"' scripts/e2e-setup.ts scripts/e2e-fixtures-*.ts | sort -u` a vyber
  číslo, ktoré tam NIE JE (napr. `9099`). (Grep len `e2e-setup.ts` je presne tá
  pasca, čo spôsobila oba zbytočné cykly.)
- **Endpoint, ktorého BEŽNÝ používateľský OMYL sa overuje cez Playwright s
  kontrolou nulovej konzoly, NESMIE vracať 4xx — a e2e s prepichnutým
  `window.fetch` túto pascu SKRYJE, chytí ju až naživo overenie na prode
  (issue 476).** Rýchle pole „Riešiť" (`POST /api/orders/riesit/by-code`) vracalo
  pri neznámom/zatvorenom čísle objednávky (typický preklep) 400. Chromium
  loguje „Failed to load resource" pre KAŽDÝ 4xx `fetch()` (existujúci bod
  vyššie), takže reálny používateľský omyl zaложил konzolovú chybu. **`riesit
  .spec.ts` to NECHYTILO**, lebo mockuje `window.fetch` na JS-úrovni (vracia
  `new Response(..., {status:400})` z overridu, NIE cez sieť) — a JS-level
  Response 4xx do konzoly NELOGUJE, na rozdiel od skutočnej sieťovej odpovede.
  `pnpm gates:local` (unit only) ani e2e teda nič nehlásili; chybu odhalil až
  post-deploy Playwright klik na prode (`console_messages` = 1 error). Fix
  (vzor `/api/catalog/ingest` `{status:"busy"}` / `POST /api/me/password`):
  server vracia **200 `{ok:false,error}`** pri očakávanom omyle, 4xx si necháva
  pre skutočné HTTP chyby (401/CSRF/malformed). **Dve poučenia:** (1) nový
  endpoint, ktorého doménový neúspech je bežný používateľský omyl, vracaj 200
  `{ok:false,error}`, nie 4xx; (2) keď e2e MOCKUJE `window.fetch`, over jeho
  status-kódy proti REÁLNEMU serveru — mock 4xx neodhalí konzolovú chybu, ktorú
  reálna 4xx odpoveď spôsobí (post-deploy naživo klik cez Playwright +
  `browser_console_messages` je jediná spoľahlivá kontrola tejto triedy).
- **Nová e2e obrazovka nad ZDIEĽANÝMI objednávkami sa NEDÁ testovať reálne
  seedovanými dátami — `orders.spec.ts`'s prvý test asertuje PRESNÉ GLOBÁLNE
  počty otvorených riadkov („Všetci (N)", „Ostáva vybaviť X z N") naprieč
  VŠETKÝMI dodávateľmi, takže KAŽDÁ nová objednávka ich rozbije, a mutovanie
  zdieľaných objednávok medzi paralelnými workermi je race (issue 476).**
  Riešenie: prepichnutý `window.fetch` (`addInitScript`, vzor
  `orders-write-failures.spec.ts`) — mockni len endpointy tej sekcie
  (`/api/orders/riesit(/count|/by-code)`, `.../lines/:id/state`), zvyšok (login,
  `/api/me`, ostatné badge counts) nechaj ísť reálne. Retry-safe, žiadna
  kolízia, reálne kliky + kontrola konzoly. Reálny endpoint end-to-end pokrýva
  API integračný test, komponent+hook unit test. (Pozor na status-kódy mocku —
  viď bod vyššie.)
- **Integračný test, ktorý cez HTTP vrstvu spúšťa logiku používajúcu REÁLNy
  `new Date()` s POSUVNÝM oknom, NESMIE mať NATVRDO zadaný dátum fixtúry —
  padne presne pri prekročení okna reálnym kalendárom (issue 480).**
  `posta-uncollected` `run-now` filtruje objednávky 30-dňovým oknom
  (`SOURCE_WINDOW_DAYS`, `isEligibleOrder` proti reálnemu `new Date()` — HTTP
  vrstva nemá injektovateľné hodiny). Fixtúry mali `placedAt: new
  Date("2026-07-25T00:00:00Z")`, čo 30. deň po tomto dátume (polnoc UTC
  2026-08-24) VYPADLO z okna → `run-now` nenašiel objednávku a 4 testy padli
  („expected 1 e-mail, got 0"). Fix: dátum RELATÍVNy k `Date.now()` (napr. 10
  dní dozadu, `placedRecently()`) — bezpečne v okne bez ohľadu na kalendár,
  rovnaký princíp ako `logic.test.ts`, ktorý si referenčný dátum (`TODAY`)
  riadi sám a volá `isEligibleOrder(order, TODAY)`. **Diagnostická stopa:** keď
  test padne LEN na neskoršom behu pri IDENTICKOM kóde (prešiel na dev, padol na
  main), over `gh run view --json createdAt` OBOCH behov — hranica polnoci UTC =
  date-fragility fixtúry, nie regresia diffu. Pri KAŽDEJ novej fixtúre pre
  real-clock filter (posta/stale-order/akékoľvek „posledných N dní") daj dátum
  relatívny, nikdy natvrdo.
- **e2e spec, ktorý mutuje GLOBÁLNu tabuľku (zoznam bez per-účet filtra, napr.
  `floor_note`), NESMIE tvrdiť GLOBÁLNu prázdnotu ani globálny počet — v CI
  bežia spec SÚBORY PARALELNE (`playwright.config.ts` `workers: undefined`),
  takže iný spec môže mať v tom istom čase vlastný záznam (issue 480).**
  `floor-notes.spec` padal na `expect(floor-notes-empty).toBeVisible()` a
  `locator('[data-testid^="floor-note-row-"]').toHaveCount(1)`, keď nový
  `floor-orders-board.spec` (ten istý globálny `floor_note` zoznam, oba účet
  `e2e-predajna@...` — no zoznam je aj tak globálny) vytvoril vlastný zápis.
  Fix: každý spec kontroluje LEN VLASTNÝ fixture — riadok filtruj podľa
  unikátneho textu (`.filter({ hasText: "..." })`) a po zmazaní over zmiznutie
  PRÁVE svojho `noteId` (`floor-note-row-${noteId}` `toHaveCount(0)`), nikdy
  globálny stav. Lokálne (`workers: 1`) sa táto kolízia NEPREJAVÍ — chytí ju až
  paralelné CI.
