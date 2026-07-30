---
paths:
  - ".github/workflows/deploy.yml"
  - "docker-compose.prod.yml"
  - "Dockerfile"
  - ".dockerignore"
  - "apps/api/src/cli/**"
  - "scripts/*.ts"
---

# Deployment (dev2)

- **Nepovinná premenná v `environment:` bloku patrí bez `:?`, ako holý kľúč
  (`SHOPTET_EXPORT_URL:`, žiadna hodnota) — NIE `${VAR:?chyba}`.** Bare kľúč
  preberá hodnotu z `/srv/forestshop/.env`, keď tam je, a keď nie je, premenná
  sa v kontajneri VÔBEC nenastaví (over: `docker compose config`) — presne to,
  čo očakáva `.optional()` v `env.ts`. `${VAR:?chyba}` (ako pri
  `POSTGRES_PASSWORD`/`CF_TUNNEL_TOKEN` nižšie) je správne LEN pre premenné bez
  ktorých appka nemá zmysel spúšťať — na nepovinnej premennej by `up -d` padal
  pri KAŽDOM deployi, kým operátor tajomstvo nedoplní (presne tento prípad:
  `SHOPTET_EXPORT_URL`, F1 Task 8, issue #8 — appka bez neho beží ďalej, len
  ručný import vráti 503). Nikdy `${VAR:-}` (prázdny reťazec) ako náhrada za
  bare kľúč — to premennú v kontajneri NASTAVÍ na `""`, čo `z.string().url()`
  v `env.ts` odmietne a appku pri štarte zhodí, hoci samotná premenná je
  deklarovaná ako nepovinná.
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
  pripravený a pripojený.
  **Rozhodnuté majiteľom 2026-07-29: hlavné meno prevezme tento systém až vo
  fáze F6**, keď sa stará appka vypína — dovtedy sa `forestshop.newlevel.media`
  nechá starému projektu (issue #5 je teraz úloha pre F6, nie otvorená otázka).

- **Dočasný verejný hostname (do fázy F6, issue #5):
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

- **Docker inicializuje ČERSTVÝ named volume kopírovaním obsahu (aj
  vlastníctva) z toho, čo v obraze UŽ existuje na tej istej ceste v momente
  prvého pripojenia volume-u** — ak `Dockerfile` cieľový adresár (napr.
  `/data/catalog-raw`, `docker-compose.prod.yml`'s `catalog-raw` volume)
  nikdy nevytvorí, Docker vytvorí mount point ako `root:root` a `USER node`
  (nižšie v obraze) doň nikdy nezapíše — presne reálny produkčný incident
  (F1 final-wave-a, položka 8: prvý import stiahol 57 MB a spadol na zápis).
  Fix: `RUN mkdir -p <cesta> && chown -R node:node <cesta>` PRED `USER node`.
  Over TÝMTO vzorom (jednorazovo, mimo Tier-0 zákazu "docker build projektového
  obrazu" — malý zahoditeľný alpine testovací obraz + čerstvý named volume):

  ```bash
  docker build -t verify:tmp - <<'EOF'
  FROM node:24-alpine
  RUN mkdir -p /data/x && chown -R node:node /data/x
  USER node
  CMD ["sh","-c","ls -ld /data/x && touch /data/x/p && echo OK"]
  EOF
  docker volume create verify-vol
  docker run --rm -v verify-vol:/data/x verify:tmp   # očakávaj: node:node, OK
  docker rmi verify:tmp && docker volume rm verify-vol
  ```

- **Retencia surových súborov (`.claude/rules/catalog.md`'s `pruneRawSnapshots`) beží
  PRIAMO v produkčnom obraze — nie cez `scripts/`.** `scripts/catalog-ingest.ts` a
  `scripts/catalog-prune-raw.ts` (spúšťané cez `pnpm catalog:*`, `tsx`) potrebujú
  celý monorepo `node_modules` — na dev2 sú `scripts/` len ako `rsync`-nutá kópia
  BEZ `node_modules` (final-wave-b, položka 2: prvý reálny produkčný import zapísal
  surový súbor a nemal ho čo niekedy zmazať, zväzok `catalog-raw` by rástol
  donekonečna). Kanonická implementácia preto žije v `apps/api/src/cli/
  catalog-prune-raw.ts` — `scripts/catalog-prune-raw.ts` je odteraz len jej tenký
  alias (`import "../apps/api/src/cli/catalog-prune-raw.js";`) pre lokálny
  `pnpm catalog:prune-raw`. `apps/api`'s vlastný `tsc -b` ju skompiluje do
  `apps/api/dist/cli/catalog-prune-raw.js`, ktorý Dockerfile UŽ kopíruje (celý
  `apps/api/dist`) — žiadna zmena Dockerfile nebola potrebná. Príkaz na produkcii:

  ```bash
  ssh newlevel@dev2 'cd /srv/forestshop && docker compose -f docker-compose.prod.yml exec app node apps/api/dist/cli/catalog-prune-raw.js'
  ```

  Vypíše jednu ľudskú vetu aj JSON riadok (`{"removed": N}`) — bezpečné spustiť
  kedykoľvek (nemaže nič mladšie než 30 dní ani posledný prijatý súbor, pozri
  `pruneRawSnapshots` v `raw-store.ts`). Import (`catalog-ingest`) toto NEPOTREBUJE —
  beží aj cez tlačidlo na webe (`POST /api/catalog/ingest`, priamo v bežiacom
  procese appky), takže `scripts/catalog-ingest.ts` zostáva len pohodlný LOKÁLNY/CI
  vstupný bod, nie produkčná nutnosť.

- **`deploy` job (self-hosted dev2) môže raz za čas zlyhať na `failed to
  extract layer ... link ... no such file or directory` počas `docker
  compose pull app`** (pozorované 2026-07-29, PR #16 — žiadna zmena
  závislostí v tom PR, čiže nešlo o obsah image, ale o lokálny
  containerd/overlayfs stav na dev2). Cesta z chyby ukazuje na hardlink
  VNÚTRI runtime obrazovej vrstvy — `runtime` štádium (`Dockerfile`) inštaluje
  produkčné závislosti ČERSTVO (`RUN pnpm install --filter @forestshop/api
  --prod`), čo napečie pnpm-ov hardlinkovaný content-addressable store
  (`/root/.local/share/pnpm/store/v10/...`) do TEJ ISTEJ vrstvy ako
  `node_modules` — ak sa pri sťahovaní/extrakcii na dev2 poškodí/vynechá
  jeden blob v containerd content-store, hardlink naň zlyhá.
  **Diagnostika (bez zásahu do bežiacich kontajnerov iných projektov na
  zdieľanom dev2):**
  ```bash
  ssh newlevel@dev2 "sudo ctr --address /run/containerd/containerd.sock -n moby snapshots ls | grep <snapshot-id z chybovej hlášky>"
  ssh newlevel@dev2 "sudo ctr --address /run/containerd/containerd.sock -n moby content ls | grep <chýbajúci sha256 prefix z chybovej hlášky>"
  ```
  (`ctr` bez `--address`/`-n moby` sa pripája na iný — prázdny — namespace a
  nič neukáže; docker's vlastný containerd socket je `/run/containerd/
  containerd.sock`, nie `/var/run/docker/containerd/containerd.sock`.)
  Ak zlyhaný snapshot aj chýbajúci blob už nie sú v zozname, docker/containerd
  si to už samo vyčistilo (rollback po zlyhanej extrakcii) — nie je čo mazať,
  `docker system prune -f` nepomôže (0B reclaimed, korupcia nie je na úrovni
  bežných "unused images"). V tomto prípade stačí `gh run rerun <run-id>
  --failed` — čerstvý pull znova stiahne vrstvu od nuly. Ak sa to isté zopakuje
  DRUHÝKRÁT za sebou, už to nie je transientný jav — over `docker system df`
  (miesto na disku) a zváž reštart `containerd`/`docker` služby na dev2.
- **OPRAVA k nižšie zdokumentovanému nálezu z #25 — NEBOL to transientný
  containerd jav, bol to skutočný, DETERMINISTICKÝ bug appky (issue 78,
  vyriešené).** Pôvodný záznam (nižšie, ponechaný pre históriu) priradil
  `Error response from daemon: No such container: <hash>_forestshop-app-1`
  počas "Recreate" k rovnakej triede ako `failed to extract layer`
  (containerd/overlayfs korupcia) — mylne, len preto, že jeden rerun vtedy
  "pomohol". Skutočná príčina: appka (`apps/api/src/index.ts`) nemala ŽIADEN
  `SIGTERM`/`SIGINT` handler a `Dockerfile`'s `CMD` beží bez init procesu
  (PID 1) — jadro preto default dispozíciu signálu vôbec neaplikovalo, appka
  SIGTERM úplne ignorovala a bežala ďalej celý `stop_grace_period` (10s), kým
  ju Docker nezabil SIGKILLom; `docker compose up`'s "Recreate" krok si
  medzitým interne pripravil "nahradiť starý kontajner" podľa jeho dočasného
  ID, ale kontajner bol už `destroy`nutý skôr, než sa k tomu kroku dostal —
  odtiaľ "No such container". Rerun vtedy "pomohol" len preto, že táto
  časovacia hra nie je pri KAŽDOM behu istá (compose's interné časovanie
  recreate kroku niekedy stihne, niekedy nie) — bug bol prítomný pri KAŽDOM
  deployi, len sa nie vždy prejavil viditeľným zlyhaním. Fix: `apps/api/src/
  shutdown.ts`'s `createShutdownHandler` (explicitný, idempotentný handler,
  zavrie HTTP server aj DB pool, `process.exit(0)`, ohraničený force-exit
  fallback) + `docker-compose.prod.yml`'s `app` service dostala explicitný
  `stop_grace_period: 15s` ako doplnkovú rezervu. **Ponaučenie pre budúci
  podobný nález:** "jeden rerun pomohol" dokazuje len že chyba je
  NEDETERMINISTICKÁ v ČASOVANÍ prejavu, nie že príčina je transientná
  infraštruktúra — over `docker events` (kill signal, timing medzi SIGTERM
  a SIGKILL) PRED zápisom "transientný jav" do playbooku.

- **PÔVODNÝ (čiastočne mylný) záznam, ponechaný pre históriu — pozri opravu
  vyššie:** DRUHÝ pozorovaný transientný symptom TEJ ISTEJ triedy (#25,
  2026-07-30): `docker compose up -d` zlyhá na `Error response from daemon:
  No such container: <hash>_forestshop-app-1` počas kroku "Recreate" — opäť
  žiadna zmena závislostí v danom PR, teda opäť lokálny containerd/docker
  stav na dev2, nie obsah image. Rovnaká liečba ako vyššie: `gh run rerun
  <run-id> --failed` (jeden rerun stačil, prešiel hneď). Ak sa PRI DEPLOJI
  objaví INÁ hláška než "failed to extract layer", nepredpokladaj
  automaticky inú príčinu — over najprv jednoduchým rerunom, až pri DRUHOM
  zlyhaní za sebou rieš ako skutočný problém.

- **`build` job (GitHub-hosted, nahráva do ghcr.io) potrebuje explicitný
  `docker/setup-buildx-action@v3` PRED `docker/build-push-action@v6`** —
  bez neho buildx použije predvolený builder s driverom `docker` (naviazaný
  na lokálny daemon runnera), ktorý nevie `push: true` počas zostavovania
  cez natívny BuildKit exportér; namiesto toho obraz najprv uloží do
  daemona a až potom spustí samostatný `docker push`. Tento dvojkrokový
  spôsob bol príčinou `ERROR: failed to build: unknown blob` pri nahrávaní
  viacerých tagov naraz (`:0.3.0-dev.18` + `:latest`) na ghcr.io (run
  30529745338, issue #42) — desiatky predchádzajúcich behov s tým istým
  chýbajúcim krokom prešli, takže ide o latentnú krehkosť builderu bez
  `docker-container` drivera, nie o vždy-zlyhá chybu. Fix je jeden riadok
  (`uses: docker/setup-buildx-action@v3`), nie retry/`continue-on-error`
  okolo push kroku.
