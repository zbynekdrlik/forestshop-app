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
- **Lokálne integračné testy sa navzájom rušia, keď bežia SÚBEŽNE proti tej
  istej zdieľanej lokálnej Postgres inštancii** (viac agentov/terminálov
  naraz) — `withCleanDb()`'s `TRUNCATE` z jedného procesu môže zasiahnuť
  rozbehnutý test druhého procesu (`duplicate key value violates unique
  constraint "users_email_unique"`, `insert or update on table "sessions"
  violates foreign key constraint`). Nie je to chyba v testovanej appke ani
  v konkrétnom teste — over si to spustením TOHO ISTÉHO súboru izolovane
  (žiadny iný `vitest`/`test:integration` beh naraz) skôr, než začneš
  ladiť. CI je bezpečné (každý job má vlastný efemérny Postgres kontajner).
  Sledované ako issue #7 (cross-cutting oprava — per-proces izolácia DB —
  zatiaľ neriešená).
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
- **Standalone skript v `scripts/*.ts` (mimo TS projektu `apps/api`) hlási
  falošné `@typescript-eslint/no-unsafe-*` na AKÝKOĽVEK priamy import z
  `"drizzle-orm"`** — nielen na tagovanú šablónu `sql` (ako pôvodne
  zdokumentované), ale aj na obyčajné funkcie ako `eq`. ESLint-ova
  type-aware kontrola tam nevie spoľahlivo odvodiť typy. Obchádzka:
  parametrizovaný/konštantný raw SQL reťazec priamo do `db.execute(...)`
  (rovnaký vzor ako existujúci `TRUNCATE` v `scripts/e2e-setup.ts`), nie
  query builder.
