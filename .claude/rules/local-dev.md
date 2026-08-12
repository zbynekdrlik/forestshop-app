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
