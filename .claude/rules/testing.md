---
paths:
  - "apps/api/tests/**"
  - "apps/api/src/**/*.test.ts"
  - "apps/api/vitest.config.ts"
  - "apps/web/vitest.config.ts"
  - "apps/web/tests/e2e/**"
  - "apps/web/playwright.config.ts"
  - "scripts/e2e-setup.ts"
---

# Tests

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
