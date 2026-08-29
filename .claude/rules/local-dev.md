---
paths:
  - "package.json"
  - "pnpm-workspace.yaml"
  - ".nvmrc"
  - ".npmrc"
  - "docker-compose.yml"
  - "tsconfig.json"
  - "tsconfig.base.json"
  - "scripts/tsconfig.json"
  - "apps/api/tests/tsconfig.json"
---

# Local development environment

- **Node 24 nežije na default PATH na dev1.** Beží cez nvm v
  `$HOME/.nvm/versions/node/v24.18.0/bin`. Každý shell príkaz v tomto repe
  potrebuje `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"` pred
  `pnpm`/`node`/`npx` — inak sa použije systémový (chýbajúci alebo starší)
  Node. `.nvmrc` (`24`) a `engines.node` (`>=24`) v `package.json` sú len
  dokumentácia zámeru, nič ich nevynucuje lokálne mimo CI.
- **pnpm ide cez corepack**, verzia pinutá v `package.json`'s
  `packageManager` (`pnpm@10.0.0`), nie nainštalovaná globálne. `.npmrc` má
  `engine-strict=true` — inštalácia zlyhá nahlas, ak Node/pnpm nesedí, namiesto
  tichého pokračovania so zlou verziou.
- **Čerstvý `git worktree` checkout (napr. autopilot-worker's izolovaná
  vetva) NEMÁ `node_modules`** — nie je súčasťou `.git`, každý strom si ho
  musí založiť sám. Bez neho `pnpm run lint` NEHLÁSI "chýba inštalácia" —
  vyzerá to ako reálna, obrovská porucha kódu: typescript-eslint's project
  service nevie vyriešiť typy zo žiadneho importovaného balíka, takže
  KAŽDÝ `.insert()`/`.values()`/atď. na cudzom module ohlási
  `no-unsafe-call`/`no-unsafe-member-access` — desiatky tisíc falošných
  chýb naraz (issue 376, nameraných presne 50546). Fix: `pnpm install`
  PRED prvým lintom v novom worktree (rýchle, `pnpm-lock.yaml` je
  nezmenený, len sa znovupoužijú balíky z pnpm store — žiadne sťahovanie).
- **Lokálna databáza beží na porte 5433** (`docker-compose.yml`,
  `127.0.0.1:5433:5432`), **CI integration/e2e joby používajú 5432** (Postgres
  ako GitHub Actions `services:` kontajner, žiadny port-mapping konflikt s
  lokálnym behom). Pri kopírovaní `DATABASE_URL` medzi lokálnym behom a CI
  logmi si všimni, že port sa líši — nie je to preklep.
- Bežný lokálny cyklus: `docker compose up -d postgres` (port 5433) →
  `pnpm --filter @forestshop/api db:migrate` → `pnpm gates:local` (výnimočne,
  keď tiket priamo zasahuje danú oblasť, aj `pnpm test:integration` /
  `pnpm --filter @forestshop/web e2e` — pozri ďalší bod).
- **Predvolená lokálna sada PRED pushom je `pnpm gates:local`** (issue 351 —
  `typecheck && lint && test`, SEKVENČNE, nikdy paralelne) — `test:
  integration` a `e2e` sa lokálne NESPÚŠŤAJÚ default. Dôvod: `ci.yml` obe
  brány aj tak znova spustí na `ubuntu-latest` (repo je verejné, zadarmo),
  takže lokálny beh je čistá duplicita nákladu — a dev1 má len 4 jadrá/7 GB,
  zdieľané s ďalšími reláciami/projektmi (namerané: záťaž 15,6, 4,2 GB swap,
  `eslint` sám 1,5 GB pri behu VŠETKÝCH brán naraz). Výnimka: keď tiket
  PRIAMO zasahuje danú oblasť (obrazovky/UI → `e2e`; prihlásenie/práca s
  databázou → `test:integration`), spusti LEN tú jednu dotknutú sadu, nikdy
  obe naraz a nikdy súbežne s `gates:local`. `pnpm lint` má explicitný
  `--concurrency=off` (ESLint 9.9+, viacvláknový lint je len experimentálny
  opt-in `--concurrency=auto|N` — na nainštalovanej `9.39.5` je `off` už aj
  tak default, takže flag lintu samotnému nič neuberá; ide o výslovné
  zafixovanie zámeru, keby sa niekedy default zmenil) a
  `apps/web/playwright.config.ts` má mimo
  CI `workers: 1` — obe zámerne, aby ani výnimočný lokálny beh nezdvojil
  zaťaženie. Merané dôkazy (peak pamäť/load pred a po) na tikete 351.
- **Ručne bežiaci `pnpm --filter @forestshop/api start`/`web dev` (napr. pre
  naživo Playwright meranie proti lokálnemu devu, `.claude/rules/frontend-
  design.md`'s metodika) zdieľa TÚ ISTÚ lokálnu Postgres inštanciu (port
  5433) ako `pnpm --filter @forestshop/api test:integration`.** `test:
  integration`'s `withCleanDb()` TRUNCATE-uje `users`/`sessions` pri KAŽDOM
  teste (`.claude/rules/testing.md`) — ak spustíš celú integračnú sadu
  MEDZI vlastným manuálnym prihlásením a ďalšou akciou, tvoja relácia aj
  účet ticho zmiznú. Prejaví sa to ZAVÁDZAJÚCO: appka vráti "Nesprávny
  e-mail alebo heslo" (issue 327, živé overenie) — vyzerá to ako zlé heslo
  alebo vyčerpaný `login-rate-limit.ts`, v skutočnosti `users` tabuľka je
  úplne prázdna. Over `SELECT email FROM users` PRED podozrievaním hesla/
  rate limitu; fix je jednoducho znova spustiť `pnpm exec tsx scripts/
  e2e-setup.ts` (reseeduje `e2e-*@forestshop.sk` účty) a prihlásiť sa
  odznova. Nespúšťaj automatizovanú testovaciu sadu (unit test beží bez DB
  a je bezpečný, ale `test:integration`/`e2e` NIE) medzi krokmi manuálneho
  naživo overovania na tej istej lokálnej DB.
- **Vzor pre "priečinok mimo hlavného `tsc -b` composite grafu, ale chcem naň
  plnú prísnu kontrolu typov"** (najprv `scripts/`, potom `apps/api/tests/`
  — issue #4): nový SAMOSTATNÝ, nekompozitný tsconfig (`extends` spoločný
  `tsconfig.base.json`, `composite: false`, `declaration: false`,
  `noEmit: true`, vlastný `include`), pridaný do root `package.json`'s
  `typecheck` ako ĎALŠIE `&& tsc -p <priečinok>/tsconfig.json` (NIE ako
  `references` v `tsc -b`'s grafe). Dôvod: `apps/api/tsconfig.json` má
  `outDir: dist`, ktorý ide priamo do produkčného Docker image — pridanie
  ďalšieho priečinka do TOHO istého kompozitného projektu by riskovalo únik
  (test/skript) súborov do `dist`; samostatný `noEmit` projekt to riziko úplne
  vylučuje. Pri tomto vzore VŽDY zároveň odstráň dotknuté globy z
  `eslint.config.js`'s `allowDefaultProject` — necháš ich tam, ESLint padne
  na "was included by allowDefaultProject but also was found in the project
  service" (project service si nový reálny `tsconfig.json` nájde sám).
- **Playwright's VLASTNÝ (bundled) chromium na `forestshop-dev` VPS-e (host,
  nie appka's kontajner) je stiahnutý do `~/.cache/ms-playwright` už pri
  `pnpm install` (postinstall), ale NENAŠTARTUJE bez niekoľkých systémových
  `.so` knižníc, ktoré čerstvý Ubuntu 24.04 image nemá** (issue 360, prvý
  živý Playwright beh na tomto boxe): `chrome-headless-shell: error while
  loading shared libraries: libnspr4.so: cannot open shared object file`.
  Fix: `sudo apt-get install -y libnspr4 libnss3 libatk1.0-0 libatk-
  bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1
  libxfixes3 libxrandr2 libgbm1 libasound2t64` (jednorazovo, systémová
  závislosť boxu — nie appky). Toto je INÝ chromium než appka's vlastný
  `/usr/bin/chromium` v `forestshop-app-1` kontajneri (`.claude/rules/
  shoptet-writeback.md`) — pri prvom Playwright behu PRIAMO na tomto hoste
  (throwaway meranie, nie e2e cez `apps/web` skript) over najprv, či
  spustenie chromia vôbec funguje, než diagnostikuješ appkový kód.
- **Live pixel meranie (`<colgroup>`/výška bloku) proti PRODUKCII (issue
  105/107/111/127/258 metodika) potrebuje majiteľove prihlasovacie údaje —
  keď ich agent v danom behu nemá (bežné pri tiketoch dispatchovaných bez
  credential handoff), rovnako rigorózna náhrada je LOKÁLNY dev server, nie
  vzdanie sa merania.** Postup (issue 360, overené): `docker compose up -d
  postgres` (alebo over, či `forestshop_app-postgres-1` na 5433 už beží) →
  `DATABASE_URL=postgres://forestshop:forestshop@127.0.0.1:5433/forestshop
  pnpm --filter @forestshop/api db:migrate` → `pnpm exec tsx scripts/
  e2e-setup.ts` (seeduje testovací účet `e2e@forestshop.sk`, NIE majiteľove
  produkčné heslo — pozri `.claude/rules/sensitive-values.md`) → `pnpm
  --filter @forestshop/api start` + `pnpm --filter @forestshop/web dev
  --port 5173 --host 127.0.0.1` na pozadí → throwaway `.mjs` skript
  (`createRequire` z `apps/web/package.json`, `require("@playwright/
  test").chromium`) prihlási sa cez `getByLabel`/`getByRole` presne ako
  e2e testy a zmeria `boundingBox()`/`getBoundingClientRect()`. Pre "pred
  zmenou" meranie na UŽ COMMITNUTOM fixe: `git checkout <predošlý-commit>
  -- <dotknuté-súbory>` (dočasne vráti len TIE súbory, Vite HMR to okamžite
  prejaví), zmeraj, potom `git checkout HEAD -- <dotknuté-súbory>` vráti
  fix späť — žiadny `git stash` netreba, keď je fix už commitnutý (na
  rozdiel od issue 303's `git stash push --keep-index`, ktoré je pre
  NEcommitnuté zmeny). Layout/CSS správanie je na lokálnom aj produkčnom
  behu identické (rovnaký kód); jediný rozdiel sú zdrojové dáta v
  tabuľkách, čo neovplyvňuje výšku/rozloženie blokov závislých len od CSS a
  počtu položiek.
- **`docker-compose.yml`'s host port (5433) je NAPEVNO — DVA súbežné
  `docker compose up -d postgres` z RÔZNYCH worktree adresárov (paralelný
  autopilot-worker dispatch, issue #317) sa preto NIKDY nedostanú každý k
  vlastnému kontajneru, hoci docker-compose-ov projektový názov (odvodený z
  adresára) je pre každý worktree iný.** Issue 400 (13. 8. 2026, súbežne s
  worktree pre issue 397): `docker ps -a` ukázal `forestshop_app-postgres-1`
  (z HLAVNÉHO checkoutu, bežal už 20+ hodín) v stave `Up`, a
  `agent-<worktree-id>-postgres-1` (zo SÚBEŽNÉHO worktree) v stave
  `Created` — teda vytvorený, ale NIKDY neštartol, presne preto, že port
  5433 už držal ten prvý. **Toto NIE JE bug, je to zámerný zdieľaný
  prostriedok** — `.claude/rules/local-dev.md`'s vlastný postup vyššie
  ("over, či `forestshop_app-postgres-1` na 5433 už beží") to už
  predpokladá. Dôsledok pre KAŽDÝ worktree/session na tomto boxe: NIKDY
  nepredpokladaj, že tvoj vlastný `docker compose up -d postgres` naozaj
  bežal — over `docker ps --format '{{.Names}}\t{{.Status}}'`, priprav sa
  použiť `forestshop_app-postgres-1` (port 5433) priamo bez ohľadu na to, z
  ktorého adresára/worktree beží tvoja relácia.
- **Ten istý zdieľaný Postgres znamená REÁLNE riziko kolízie medzi
  SÚBEŽNÝMI e2e/integration behmi z RÔZNYCH worktree — `scripts/
  e2e-setup.ts`'s TRUNCATE nemá `withCleanDb()`'s advisory zámok
  (`.claude/rules/testing.md`).** Pred spustením `pnpm --filter
  @forestshop/web e2e`/`pnpm test:integration` na zdieľanom boxe over NAJPRV
  `ps aux | grep -E "vitest|playwright test|e2e-setup"` (žiadny bežiaci
  proces INÉHO worktree) A `docker exec forestshop_app-postgres-1 psql -U
  forestshop -d forestshop -t -c "select count(*) from pg_stat_activity
  where state != 'idle' and pid != pg_backend_pid();"` (očakávaj `0`) — až
  potom spusti. Issue 400 malo súbežne bežiaci worker na issue 397 v inom
  worktree; overenie pred spustením ukázalo pokojné okno (0 aktívnych
  spojení), e2e beh (55/55 testov) prebehol bez viditeľnej kolízie. Toto
  je RUČNÁ disciplína (žiadny zámok to nevynucuje) — pri podozrení na
  "cudzie" dáta/zlyhanie počas e2e behu na tomto boxe najprv over súbežné
  procesy, až potom hľadaj regresiu vo vlastnom diffe.
- **Keď lokálny e2e beh proti zdieľanej `forestshop_app-postgres-1` (5433)
  padá NEVYSVETLITEĽNE (zlé heslo pri overene správnom účte, FK porušenie
  na tabuľke, ktorú si sám nesiahol) A na boxe bežia SÚBEŽNÉ worktree
  relácie (iné autopilot-worker tikety), podozrievaj NAJPRV kolíziu so
  `scripts/e2e-setup.ts`'s nezamknutým TRUNCATE (`.claude/rules/testing.md`)
  — a najspoľahlivejší fix nie je čakať na tiché okno, ale spustiť si
  ÚPLNE VLASTNÚ, izolovanú Postgres inštanciu.** Issue 403: `ps aux | grep
  -E "vitest|playwright|e2e-setup"` ukázalo prázdno, no `pnpm exec tsx
  scripts/e2e-setup.ts` napriek tomu spadol na `insert or update on table
  "order_line" violates foreign key constraint` (`order_id` odkazoval na
  medzičasom zmazaný `order` riadok) — klasický odtlačok TRUNCATE-u
  bežiaceho SÚBEŽNE s INOU reláciou (krátkodobý proces, čo `ps aux`
  jednoducho nestihol zachytiť). Namiesto opakovaného čakania/skúšania:
  `docker run -d --name <unikátny-názov> -p 127.0.0.1:<voľný-port>:5432 -e
  POSTGRES_USER=forestshop -e POSTGRES_PASSWORD=forestshop -e
  POSTGRES_DB=forestshop postgres:18` → `DATABASE_URL=postgres://forestshop
  :forestshop@127.0.0.1:<port>/forestshop pnpm --filter @forestshop/api
  db:migrate` → `pnpm --filter @forestshop/web e2e` s tým istým
  `DATABASE_URL` (Playwright's vlastný `webServer` si `e2e-setup.ts` aj
  API spustí sám). Presne táto ISTÁ izolácia, akú CI dostáva zadarmo
  (vlastný efemérny Postgres kontajner na job) — 59/59 e2e testov prešlo
  načisto po prechode na izolovanú inštanciu, zatiaľ čo DVA po sebe idúce
  pokusy proti zdieľanej 5433 zlyhali z DÔVODOV NESÚVISIACICH s
  testovaným diffom. `docker rm -f <unikátny-názov>` po overení — jednorazová
  inštancia, žiadny cleanup skript netreba. Použi UNIKÁTNY názov kontajnera
  a VOĽNÝ port (`ss -ltnp | grep :<port>` najprv) — súbežný worktree môže
  robiť to isté.
- **Podozrenie "flaky integračný test = zdieľaná-Postgres TRUNCATE kolízia"
  (bod vyššie) sa dá DOKÁZAŤ, nielen odvodiť z toho, že izolovaný beh
  prešiel — spusti test na VLASTNEJ throwaway inštancii (postup vyššie) a v
  strede jeho behu ZÁMERNE vykonaj presne taký TRUNCATE, aký by
  `scripts/e2e-setup.ts` spravil, priamo cez `docker exec <kontajner> psql
  -U forestshop -d forestshop -c "TRUNCATE TABLE <tabuľka>;"`.** Issue 405
  (`shoptet-writeback-sequence.integration.test.ts`): timing na základe
  reálnych log časových pečiatok testu (kedy appka danú tabuľku číta/píše)
  + `sleep <N> && docker exec ...` spustený na pozadí PRED foreground
  behom testu — obidva nahlásené, na prvý pohľad nesúvisiace tvary
  zlyhania sa takto reprodukovali 1:1 (bajt-za-bajt zhodná chybová
  hláška), na NULOVOM riziku pre zdieľaný box (vlastný kontajner). Toto je
  silnejší dôkaz než "izolovaný beh prešiel N-krát" samotné — priamo
  potvrdzuje MECHANIZMUS, nie len koreláciu. Cielené spustenie LEN jedného
  súboru/testu proti vlastnému `DATABASE_URL` (namiesto celej `test:
  integration` sady): `DATABASE_URL=postgres://forestshop:forestshop
  @127.0.0.1:<port>/forestshop pnpm --filter @forestshop/api exec vitest
  run tests/<súbor>.integration.test.ts -t "<časť názvu testu>"` — `exec`
  (nie `test:integration` skript) obchádza balíkov skript a nechá vitest-ov
  vlastný `-t` filter fungovať priamo (na rozdiel od `pnpm ... e2e --`
  vyššie v tomto súbore, `vitest run` NEMÁ ten istý `--`-argument problém —
  `exec vitest run <cesta> -t <vzor>` filtruje správne).
- **`vitest`/esbuild spustený VNÚTRI worktree si vie svoj "koreň" nájsť
  AŽ v HLAVNOM checkoute, nie vo worktree samotnom — pretože worktree je
  FYZICKY VNORENÝ pod ním (`.claude/worktrees/agent-<id>/`), nie
  súrodenský adresár.** Zistené issue 412: `pnpm --filter @forestshop/api
  exec vitest run ...` spadol na `Expected string in JSON but found "<<"`
  pri čítaní `../../../../../package.json` — presne 5 adresárov nad
  `apps/api/` je HLAVNÝ checkout (`apps/api → apps → <worktree-root> →
  worktrees → .claude → forestshop_app`), ktorého `package.json` mal v
  danej chvíli živé merge-konfliktové značky (`<<<<<<< HEAD`) — supervisor
  ho práve integroval so súbežným worktree. Vlastný `package.json`
  WORKTREE-u (2 úrovne nad `apps/api/`) bol celý čas v poriadku — esbuild-
  ova/vite-ova detekcia "koreňa" (pravdepodobne hľadanie NAJBLIŽŠIEHO
  SKUTOČNÉHO `.git` ADRESÁRA, nie súboru — worktree má `.git` len ako
  SÚBOR-odkaz na zdieľaný `.git`) ho obišla a doliezla až po skutočný
  `.git` adresár v hlavnom checkoute. **Toto NIE JE chyba vo worktree ani
  v jeho `package.json`** — je to dôsledok toho, že worktree fyzicky sedí
  POD hlavným checkoutom, kombinovaný s tým, že hlavný checkout môže mať
  KEDYKOĽVEK dočasne nevalidný `package.json` (prebiehajúci merge). Fix
  NIE JE dotknúť sa hlavného checkoutu (zakázané, `WORKTREE AWARENESS`) —
  počkaj (ohraničený poll na `node -e "JSON.parse(readFileSync(hlavný
  package.json))"`, nie slepý sleep) a skús znova; supervisor-ov merge je
  prechodný stav, o pár desiatok sekúnd/minút zmizne. Príznak na
  rozoznanie od skutočnej chyby vo vlastnom kóde: chybová cesta v hláške
  (`../../../../../package.json` alebo podobný dlhý reťazec `../`)
  ukazuje MIMO worktree — over ju `readlink -f`/počítaním `../` PRED tým,
  než začneš ladiť vlastný `vitest.config.ts`.
- **`git diff <base>..HEAD` (dvojbodkový tvar) v salvage/pokračovacom
  worktree-i, ktorý PRED implementáciou robil `git merge origin/dev`,
  zahŕňa AJ zmeny z toho mergu — nielen prácu na aktuálnom tikete.**
  Issue 413 (salvage): `<base>` bol commit PRED `git merge origin/dev`
  (ktorý priniesol issue 412's samostatnú prácu), takže `git diff
  <base>..HEAD` ukázal issue 412's súbory (`modules/orders/`, `cli/
  orders-ingest.ts`, ...) POMIEŠANÉ s issue 413's reálnym diffom — dvojbodkové
  `diff` je čistá stromová diferencia dvoch commitov, nerozlišuje "reachable
  vs. ancestor" tak, ako to robí `git log A..B`. Dispatch pre nezávislý
  review subagent, čo dostal tento zlý rozsah, musel byť opravený `SendMessage`-om
  s presným príkazom `git diff <merge-commit>..HEAD` (rozsah AŽ OD merge
  commitu, nie od pôvodného base). Pri KAŽDOM ĎALŠOM "recenzuj rozsah
  A..B" dispatch-i na vetve, čo obsahovala `git merge origin/<base>`
  UPROSTRED práce: over `git log --oneline A..B` NAJPRV (mal by ukázať LEN
  commity tohto tiketu), a ak zoznam obsahuje cudzie SHA, posuň `A` na
  merge commit samotný.
- **Cielený lokálny e2e beh na `forestshop-dev` môže zlyhať na
  `http://127.0.0.1:3000/api/version is already used` — port 3000 na tomto
  ZDIEĽANOM boxe drží CUDZÍ (nie-forestshop) proces, nie appka (issue 521;
  prod appka je v kontajneri, publikuje 8901→3000, nie host:3000).** Cudzí
  proces sa NEZABÍJA (`no-destructive-remote-actions.md`). `playwright.config.ts`
  má porty 3000 (API) a 5173 (vite) NATVRDO. API port je env-prepínateľný
  (`env.PORT`, default 3000), ALE **vite proxy cieľ je v `vite.config.ts`
  NATVRDO (`proxy: { "/api": "http://127.0.0.1:3000" }`)**, takže presun API
  portu vyžaduje aj DOČASNÚ zmenu `vite.config.ts`. Postup (overené #521):
  DOČASNE (necommitované) `sed -i 's|3000|3001|'` v `vite.config.ts` (proxy)
  + v `playwright.config.ts` (webServer `url` + do `env` pridaj `PORT: "3001"`),
  spusti proti VLASTNEJ izolovanej pg (recept vyššie, issue 403), potom
  `git checkout -- apps/web/vite.config.ts apps/web/playwright.config.ts`
  (revert PRED akýmkoľvek `git add`). Vite na 5173 ostáva (býva voľný — over
  `ss -ltn`). Cielené spustenie LEN vybraných spec-ov: `DATABASE_URL=...
  pnpm --filter @forestshop/web exec playwright test tests/e2e/<a>.spec.ts
  tests/e2e/<b>.spec.ts` (`exec` + priame cesty, nie `e2e --`, ktoré spustí
  všetko — `.claude/rules/testing.md`).
