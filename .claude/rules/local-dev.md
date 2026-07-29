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
  `pnpm --filter @forestshop/api db:migrate` → `pnpm test` /
  `pnpm test:integration` / `pnpm --filter @forestshop/web e2e`.
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
