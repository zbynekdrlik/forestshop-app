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
  vlastníka projektu, kým doména patrí ktorému systému (issue #5).

- **Dočasný verejný hostname (kým sa nerozhodne issue #5):
  `forestshop-novy.newlevel.media`.** Beží na samostatnom tunneli
  `forestshop-app` (id `e0cdc5bf-fbc8-45de-b1f7-f4c0b2a9b0dc`), ingress
  `forestshop-novy.newlevel.media` → `http://app:3000` (popri pôvodnom
  `forestshop.newlevel.media` ingress pravidle na tom istom tuneli — obe
  smerujú na tú istú appku, líšia sa len menom). CNAME záznam vytvorený v
  zóne `newlevel.media` (`b9019ca...`), `proxied: true`.
  - **Prečo nie `novy.forestshop.newlevel.media` (pôvodne zamýšľaný tvar)?**
    Cloudflare Universal SSL certifikát tejto zóny pokrýva len
    `newlevel.media` + `*.newlevel.media` (jedna úroveň wildcard) — overené
    `openssl s_client` + SAN výpisom certifikátu. Hostname o dve úrovne pod
    apexom preto pri TLS handshake padá (`sslv3 alert handshake failure`).
    Riešenie by vyžadovalo Cloudflare Total TLS / Advanced Certificate Manager
    (samostatné oprávnenie `SSL and Certificates:Edit` na API tokene — token
    použitý v F0 má len Tunnel Write + DNS Write + Zone Read + Account
    Settings Read a na `/acm/total_tls` aj `/ssl/certificate_packs` vracia
    autorizačnú chybu). Namiesto rozširovania oprávnení tokenu pre dočasný
    hostname bol zvolený tvar o jednu úroveň nižšie (`forestshop-novy.` priamo
    pod `newlevel.media`), ktorý sedí do existujúceho wildcard certifikátu bez
    ďalších zásahov.
  - **Prepnutie na finálny hostname po rozhodnutí issue #5:**
    1. Zmeniť `LIVE_HOSTNAME` v `.github/workflows/deploy.yml` (jeden riadok).
    2. Ak finálny hostname má byť opäť `forestshop.newlevel.media` (t.j. tento
       projekt preberie meno): zmazať/presmerovať pôvodný záznam u súrodenca
       (mimo tohto repa) a v CNAME zázname tejto appky prepísať `name` na
       `forestshop.newlevel.media` (alebo pridať nový záznam a zmazať dočasný
       `forestshop-novy`).
    3. Ak finálny hostname zostáva iný ale je jednoúrovňový pod
       `newlevel.media` → žiadny certifikátový problém, len DNS CNAME + ingress
       hostname update cez Cloudflare API (rovnaký postup ako vyššie).
    4. Ak sa má použiť viacúrovňový tvar ako pôvodne zamýšľaný
       `novy.forestshop.newlevel.media` → najprv treba na Cloudflare API tokene
       doplniť oprávnenie `SSL and Certificates:Edit` a zapnúť Total TLS
       (`PATCH /zones/{zone}/acm/total_tls`) alebo objednať Advanced
       Certificate, inak TLS handshake opäť zlyhá.
