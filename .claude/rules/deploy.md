---
paths:
  - ".github/workflows/deploy.yml"
  - "docker-compose.prod.yml"
  - "Dockerfile"
  - ".dockerignore"
---

# Deployment (dev2)

- **Kam sa nasadzuje:** `/srv/forestshop` na dev2 (vlastník `newlevel`).
  Obsahuje `.env` (mode 600 — `POSTGRES_PASSWORD`, `CF_TUNNEL_TOKEN`),
  `docker-compose.prod.yml` (kopírovaný z repa pri každom deploy) a
  `scripts/` (synchronizovaný `rsync -a --delete` z repa pri každom deploy —
  predtým tam ležala ručne položená kópia, ktorá by sa tichým opomenutím
  rozišla od gitu naveky; teraz je vynútené, že dev2 má vždy presne to, čo je
  v repe).
- **Self-hosted runner:** `dev2-forestshop`, labels
  `self-hosted,Linux,X64,dev2`, beží ako systemd služba
  `actions.runner.zbynekdrlik-forestshop-app.dev2-forestshop.service`
  (enabled, prežije reboot). `deploy` job cieli `runs-on: [self-hosted,
  dev2]`.
- **Tag obrazu tečie z build jobu do deploy jobu cez `needs.build.outputs`,
  NIE cez `:latest`.** `build` job nastaví `outputs.version` (verzia z
  `package.json`), `deploy` job ho číta do `env.IMAGE_TAG` a použije ho pri
  `docker compose pull app` aj `up -d` (compose súbor interpoluje
  `${IMAGE_TAG:-latest}`). Bez tohto by dva rýchlo po sebe idúce merge do
  `main` mohli spôsobiť, že novší build stiahne starší `:latest`. Workflow má
  aj `concurrency: { group: deploy, cancel-in-progress: false }` — deploy sa
  nikdy nezruší uprostred behu, druhý push len počká vo fronte.
- **Deploy overuje živú verziu proti `package.json`** — posledný krok
  `deploy.yml` curluje `https://forestshop.newlevel.media/api/version` a
  porovná s `require('./package.json').version`; zlyhá nahlas pri
  nezhode, nikdy nehlási úspech naslepo.
- **Docker build je súčasťou CI (`docker-build` job v `ci.yml`), beží pri
  KAŽDOM push/PR**, nielen pri deploy — deploy cesta sa tak overuje ešte pred
  mergom. `.dockerignore` musí mať `**/`-prefixované vzory
  (`**/node_modules`, `**/dist`, `**/*.tsbuildinfo`, `**/playwright-report`,
  `**/test-results`) — Docker ignore semantika bez `**/` matchuje len bare
  názvy v koreni kontextu, nie v podadresároch typu `apps/api/dist`.
- **Verejný hostname `forestshop.newlevel.media` je zdieľaný problém, nie
  technický detail.** V čase F0 ho živo obsluhoval iný projekt
  (`parovanie_produktov`, rozhodnutie z 2026-07-22, issue #120 v tamojšom
  repe) — presmerovanie DNS na nový systém by ho ticho odpojilo. Cloudflare
  tunnel pre tento projekt (`forestshop-app`, samostatný od súrodenca) je
  pripravený a pripojený; samotný DNS `A`/`CNAME` záznam čaká na rozhodnutie
  vlastníka projektu, kým doména patrí ktorému systému.
