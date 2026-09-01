---
paths:
  - ".github/workflows/deploy.yml"
  - "docker-compose.prod.yml"
  - "Dockerfile"
  - ".dockerignore"
  - "apps/api/src/cli/**"
  - "scripts/*.ts"
  - "scripts/*.sh"
---

# Deployment (forestshop-dev — presunuté z dev2, issue 366)

- **Verejná adresa APPKY je `forestshop.newlevel.media` — NIE
  `forestshop-dev.newlevel.media`.** `forestshop-dev.newlevel.media` je len
  A záznam (DNS-only, proxied=false) na verejnú IP boxu pre SSH/označenie
  servera; na boxe na :443 nič nepočúva (appka beží na 127.0.0.1:8901 za
  Cloudflare tunelom), takže `curl`/Playwright na `forestshop-dev.…` skončí
  `ERR_CONNECTION_REFUSED` na ÚPLNE ZDRAVEJ appke — nie je to výpadok
  (falošný poplach 1. 9. 2026 pri live overení issue 531). Live verify,
  uptime check aj všetky 🌐 odkazy vždy na `https://forestshop.newlevel.media`.

- **Cloudflare Error 1033 / HTTP 530 na oboch verejných adresách = tunel bez
  živého spojenia, NIE appka (issue 357, výpadok 12. 8. 2026 ráno).**
  `cloudflared` sa predvolene pripája protokolom QUIC (UDP 7844); keď QUIC
  handshake na sieti dev2 prestane prechádzať (`ERR Failed to dial a quic
  connection error="failed to dial to edge with quic: timeout: handshake
  did not complete in time"` na všetkých štyroch spojeniach naraz), appka aj
  DB bežia ďalej v poriadku (lokálne `HTTP 200` na dev2), len Cloudflare
  nemá kam smerovať požiadavky. Diagnostika: `docker logs
  forestshop-cloudflared-1` (hľadaj `quic`), `docker inspect
  forestshop-cloudflared-1 --format '{{json .Config.Cmd}}'` (over aktuálny
  príkaz). Oprava: `--protocol http2` v `cloudflared`'s `command:` v
  `docker-compose.prod.yml` — vynúti TCP 443 namiesto UDP, bezpečná voľba
  bez ohľadu na to, či bol QUIC výpadok dočasný alebo trvalý (mierne
  pomalšie, zanedbateľne). **Táto zmena MUSÍ byť v repozitárovom
  `docker-compose.prod.yml`, nie len ručne na dev2** — `deploy.yml`'s
  `cp "$GITHUB_WORKSPACE/docker-compose.prod.yml" .` krok pri KAŽDOM
  nasadení kompletne prepíše `/srv/forestshop/docker-compose.prod.yml`
  súborom z repa; ranná ručná oprava priamo na serveri by prvým ďalším
  nasadením potichu zmizla a výpadok by sa zopakoval.
  **`--protocol http2` je od `cloudflared` 2026.7.3 nezdokumentovaný —
  funguje (overené naživo proti bežiacemu `cloudflared:latest`), ale vo
  vlastnom `cloudflared tunnel --help` výstupe už nie je uvedený.** Keď po
  najbližšom zdvihnutí verzie obrazu (`docker-compose.prod.yml`'s
  `cloudflare/cloudflared:latest`) tunel znovu spadne, over NAJPRV, či
  prepínač nebol pri tej príležitosti (napr. pri čítaní `--help`) omylom
  odstránený ako "neexistujúci" — nepredpokladaj automaticky, že ide o ten
  istý QUIC problém.
- **Vonkajšie sledovanie dostupnosti (issue 357):** appka predtým nemala nič,
  čo by z VONKU kontrolovalo, či verejná adresa žije — výpadok objavil
  majiteľ, nie automatika. `scripts/uptime-check.sh` (v tomto repe) beží cez
  systemd `--user` timer **na dev1** (zámerne NIE na tom istom stroji, čo
  beží appka — monitor na tom istom stroji, čo sleduje, by zomrel spolu s
  tým, čo má hlásiť; rovnaký vzor ako
  `api-watchdog.timer`/`imag-obs-alert-watchdog.timer`), kontroluje
  verejnú adresu `forestshop.newlevel.media` (default od issue 488 už len
  hlavná; `UPTIME_CHECK_URLS` override vie pridať ďalšie) každých 5 minút,
  alertuje až po 2
  zlyhaniach za sebou (~10 min súvislého výpadku, nie jeden blik) cez
  `~/devel/airuleset/airuleset.py notify --body ... --owner-name marek
  --dedup-key ...`. **Routing alertov (issue 499, doktrína analyze-not-ping —
  airuleset #704/#705):** telefón (Discord) dostane LEN genuine nový actionable
  prechod stavu — prvé potvrdenie výpadku a zotavenie — vždy s per-incident
  `--dedup-key` (`forestshop-uptime:<down|up>:<url>:<incident-id>`), takže ten
  istý prebiehajúci incident NEpinguje znova; prebiehajúci (už oznámený)
  výpadok sa na každom ďalšom prechode zapíše LEN do journalu (machine
  channel), nikdy znova na telefón. Keyless `notify --body` (bez `--dedup-key`)
  je flood primitív a je v skripte ZAKÁZANÝ. Logika je testovaná
  `scripts/uptime-check.test.sh` (root `pnpm test:uptime-script`, beží v CI
  `check` jobe cez PATH-stub `curl`/`python3`/`date`).
  **GOTCHA — airuleset drží dedup marker aj po TRANSIENT zlyhaní POSTu
  (`notify/__init__.py`, „a timeout can fire AFTER Discord accepted"); marker
  uvoľní LEN pri no-token/no-channel.** Preto retry alertu s ROVNAKÝM
  `--dedup-key` po zlyhanom `notify` je airulesetom ZDEDUPOVANÝ (tichý výpadok).
  Down alert sa preto označí ako oznámený AŽ po úspešnom doručení a retry použije
  NOVÝ incident-id (nový kľúč) — platí pre KAŽDÝ budúci alert skript v tomto repe,
  čo volá airuleset `notify` a chce „nikdy nezmeškaj". **Systemd
  `.timer`/`.service` súbory sa NEVERZUJÚ do repa** (`~/.config/systemd/user/
  uptime-check.{timer,service}` na dev1, rovnaký vzor ako
  `parovanie-backup.timer`) — repo drží len skript, inštalácia je ručný
  jednorazový krok. Stavový súbor (potvrdzovací počítadlo + alerted flag +
  incident-id) je v `${XDG_RUNTIME_DIR:-/tmp}` —
  netreba ho zálohovať, monitor sa po reštarte dev1 sám znovu rozbehne od
  nuly (najhorší prípad: jeden alert navyše, nikdy tichý výpadok).

- **Kontajner beží v `TZ=Europe/Bratislava` (issue 293) — nastavené DVAKRÁT,
  zámerne.** `Dockerfile`'s `ENV TZ=Europe/Bratislava` (runtime štádium) je
  baked-in predvolená hodnota v samotnom obraze; `docker-compose.prod.yml`'s
  `TZ: Europe/Bratislava` v `app`'s `environment:` bloku ju robí
  explicitnou/prepísateľnou na úrovni nasadenia, rovnaká disciplína ako
  každá iná premenná nižšie. Predtým appka aj kontajner bežali BEZ
  nastaveného pásma (teda v UTC) — naplánované úlohy (`.claude/rules/
  scheduler.md`) tak reálne behali o 1-2 hodiny neskôr, než majiteľ
  nastavil. Node 24's plné ICU rozlíši `TZ` SPRÁVNE aj bez `tzdata`
  balíka (overené priamo: `docker run --rm -e TZ=Europe/Bratislava
  node:24-alpine node -e '...'` dal správny +1/+2 offset s nula
  nainštalovanými balíkmi) — `tzdata` (v `Dockerfile`'s `apk add`) je tu
  napriek tomu, lebo Alpine's `/usr/share/zoneinfo` inak vôbec neexistuje a
  musl-linkované nástroje MIMO Node/V8 (napr. shellov vlastný `date`)
  bez neho ticho spadnú späť do UTC — overené priamo (`date` v holom
  obraze ukázal UTC aj s `TZ` nastaveným, správny CEST čas až po `apk add
  tzdata`). Postgres-ova VLASTNÁ session `timezone` ostáva zámerne UTC
  (`timestamptz` stĺpce sa VŽDY ukladajú v UTC bez ohľadu na session
  pásmo — to je odporúčaná prax, nie chyba) — appka prevádza na slovenský
  čas AŽ pri čítaní/plánovaní (`apps/api/src/timezone.ts`), nikdy sa
  nespolieha na to, že DB samotná vráti lokálny čas.
- **Nová premenná v `env.ts` MUSÍ dostať svoj riadok v `environment:` bloku
  `docker-compose.prod.yml` — inak sa do kontajnera NIKDY nedostane, aj keby
  bola korektne nastavená v `/srv/forestshop/.env`.** Compose neprenáša `.env`
  do kontajnera automaticky: `.env` slúži len na interpoláciu `${...}` v samotnom
  compose súbore a na `env_file`; premenná bez riadku v `environment:` sa v
  kontajneri jednoducho nenastaví, appka ju vidí ako chýbajúcu a `.optional()`
  vetva sa tvári ako "operátor to ešte nenastavil". Presne toto sa stalo pri
  issue 198: `MAIL_BCC` a `NEDOSTUPNE_BCC_EMAIL` boli v `.env` nastavené,
  obrazovka „Nedostupné tovary" napriek tomu hlásila chýbajúcu adresu a
  automatizácia zostávala fail-closed. **Kontrola, ktorá to odhalí za sekundu**
  (rob ju pri KAŽDOM pridaní premennej do `env.ts`, ešte pred hľadaním chyby v
  kóde):
  ```bash
  ssh admin@forestshop-dev.newlevel.media 'docker exec forestshop-app-1 sh -c "env | grep -E \"<PREMENNA>\""'
  ```
  Prázdny výstup = chýbajúci riadok v compose, nie chyba v appke.
  **Zopakovalo sa presne to isté (issue 292, PR 324/9.8.2026):**
  `DPD_PORTAL_USER`/`DPD_PORTAL_PASSWORD`/`DPD_PORTAL_BASE_URL` boli v
  `env.ts` `.optional()` už od F1 (schéma/UI nasadené skôr, kód čakal na
  prihlasovacie údaje), ale riadok v `docker-compose.prod.yml` NIKDY
  nepribudol — appka na `/srv/forestshop/.env`'s hodnoty čakala TÝŽDNE,
  no do kontajnera sa nikdy nedostali. Odhalené AŽ pri prvom skutočnom
  post-deploy overení ("Preprava DPD" stále hlásila nenakonfigurované, hoci
  `.env` mal obe hodnoty). **Ponaučenie: `env.ts`'s `.optional()` premenná
  bez sprievodnej `docker-compose.prod.yml` riadky je TICHÁ medzera, ktorá
  môže prežiť VEĽA nasadení bez povšimnutia — kontrola vyššie patrí do
  KAŽDÉHO PR-u, čo pridáva novú `env.ts` premennú, nie len do toho, čo ju
  prvýkrát POUŽÍVA v kóde.** Táto konkrétna trieda YAML-konfiguračnej
  medzery (žiadna appka logika, žiadny testovateľný kód) nemá v tomto repe
  automatizovaný testovací postih — kontrola vyššie (`docker exec ... env |
  grep`) JE regresným testom, robeným ručne pri KAŽDOM ďalšom pridaní
  premennej.
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
- **Kam sa nasadzuje (od 12. 8. 2026 — presunuté z dev2, issue 366):**
  `/srv/forestshop` na vyhradenom Hetzner VPS **`forestshop-dev`**
  (`forestshop-dev.newlevel.media`, `178.105.89.168`, nbg1; 2 CPU / 4 GB RAM
  / 38 GB disk), vlastník `admin` (predtým `newlevel` — ten účet na tomto
  stroji už neexistuje). Druhý, od appky nezávislý Linux účet `stepan` má na
  tom istom stroji vlastný izolovaný klon repa — obidva účty môžu bežať
  vlastné Claude relácie bez vzájomného rušenia. SSH: `ssh
  admin@forestshop-dev.newlevel.media` (alebo priamo IP). **Playbook
  príkazy s týmto `ssh` prefixom sú písané pre reláciu bežiacu na dev1** —
  Claude relácia, ktorá už beží PRIAMO na `forestshop-dev` (napr. `stepan`'s
  vlastný klon, alebo self-hosted runner), rovnaké príkazy spúšťa lokálne,
  bez `ssh` prefixu (over `hostname` pri pochybnosti, ktorý prípad práve
  platí — issue 371, 12. 8. 2026).
  Obsahuje `.env` (mode 600 — `POSTGRES_PASSWORD`, `CF_TUNNEL_TOKEN`),
  `docker-compose.prod.yml` (kopírovaný z repa pri každom deploy) a
  `scripts/` (synchronizovaný `rsync -a --delete` z repa pri každom deploy —
  predtým tam ležala ručne položená kópia, ktorá by sa tichým opomenutím
  rozišla od gitu naveky; teraz je vynútené, že server má vždy presne to, čo
  je v repe).
  **Na dev2 ostáva `forestshop-postgres-1` bežať ďalej ako záložná kópia dát**
  (majiteľove rozhodnutie, ticket 366) — appka a cloudflared tam boli pri
  presune odstránené, dev2 sa už NIKDY nemá stať cieľom nasadenia znova.
- **Self-hosted runner:** `forestshop-dev-runner`, label `forestshop-dev`,
  beží ako systemd služba
  `actions.runner.zbynekdrlik-forestshop-app.forestshop-dev-runner.service`
  na `forestshop-dev` (enabled, prežije reboot). `deploy` job cieli
  `runs-on: [self-hosted, forestshop-dev]`.
  **Starý `dev2-forestshop` runner (label `dev2`) ostáva zaregistrovaný, ale
  nečinný** — žiadny workflow naň už necieli; ponechaný ako rollback cesta.
  **Runner potrebuje systémovo nainštalovaný Node.js (issue 366, prvý beh po
  presune na `forestshop-dev` zlyhal `node: command not found`)** — posledný
  krok `deploy` jobu ("Overiť verziu na živej stránke") beží `node -p ...`
  PRIAMO v shelli runnera (nie v Docker kontajneri appky), a `apt`/nový
  server ho automaticky nemá. Fix: `sudo apt-get install -y nodejs` (Node
  ≥24, cez NodeSource repo — `curl -fsSL https://deb.nodesource.com/
  setup_24.x | sudo -E bash -` PRED `apt-get install`) na `forestshop-dev`,
  reštart runner služby. Ak sa runner niekedy znova presunie/prestaví na
  úplne novom stroji, over TOTO ako prvé, PRED tým, než sa hľadá iná príčina
  zlyhania overovacieho kroku.
  Zoznam runnerov repa:
  `gh api repos/zbynekdrlik/forestshop-app/actions/runners`.
- **Tag obrazu tečie z build jobu do deploy jobu cez `needs.build.outputs`,
  NIE cez `:latest`.** `build` job nastaví `outputs.version` (verzia z
  `package.json`), `deploy` job ho číta do `env.IMAGE_TAG` a použije ho pri
  `docker compose pull app` aj `up -d` (compose súbor interpoluje
  `${IMAGE_TAG:-latest}`). Bez tohto by dva rýchlo po sebe idúce merge do
  `main` mohli spôsobiť, že novší build stiahne starší `:latest`. Workflow má
  aj `concurrency: { group: deploy, cancel-in-progress: false }` — deploy sa
  nikdy nezruší uprostred behu, druhý push len počká vo fronte.
- **Nasadenie overuje živú verziu s retry a AUTOMATICKÝM rollbackom
  (`scripts/deploy-verify.sh`, issue 425 — výpadok 13. 8. 2026).** Deploy job
  už nemá inline `sleep 5` + jeden curl. Celý tok (zapamätaj predošlý image →
  pull + up → over `/api/version` v retry slučke → pri zlyhaní vráť predošlý
  image → over zotavenie) je v `scripts/deploy-verify.sh`:
  - **PRED nasadením** si zapamätá tag práve bežiaceho image
    (`docker compose ps -q app` → `docker inspect --format '{{.Config.Image}}'`,
    z neho `${img##*:}`). Deploye vždy pinujú `IMAGE_TAG=<verzia>` (nie
    `:latest`), takže tag je jednoznačný.
  - **Overenie je retry slučka** (default `VERIFY_RETRIES=12` × `VERIFY_INTERVAL=5`
    s = do ~60 s), nie jeden pokus po `sleep 5` — pomalý zdravý štart s
    migráciami už nie je falošné zlyhanie. 502/nedostupnosť pri jednom pokuse
    sa CHYTÍ (`if curl ...; then`) a skúša sa znova, `set -euo pipefail` skript
    nezhodí.
  - **Pri zlyhaní overenia (alebo pádu `pull`/`up`)** skript automaticky vráti
    predošlý image (`IMAGE_TAG=<predošlá> docker compose up -d app`) a overí, že
    sa produkcia zotavila (hlási predošlú verziu). Job **napriek tomu skončí
    nenulovo** — je červený, aby bolo jasné, že nová verzia nešla — ale
    produkcia beží ďalej na predošlej verzii namiesto ~10 min výpadku.
  - **Poradie krokov v `deploy.yml`:** „Upratať staršie obrazy" beží AŽ ZA
    skriptom (predtým pred overením). Keby bežalo pred ním, zmazalo by práve
    ten predošlý image, na ktorý rollback potrebuje siahnuť; a keďže Actions po
    zlyhanom kroku ďalšie preskočí, pri rollbacku sa upratovanie nespustí a
    predošlý image ostane lokálne.
  - **Testovanie:** `scripts/deploy-verify.test.sh` (root `pnpm test:deploy-script`,
    beží v CI `check` jobe pri každom push/PR) mockuje `docker`/`curl` cez PATH
    stuby a overí 5 vetiev (šťastná cesta, pomalý štart s retry, rollback sa
    zotaví, žiaden predošlý image, rollback tiež zlyhá). CI skutočný produkčný
    deploy odbehnúť nevie — táto logika sa testuje takto.
  - **Ručné overenie / rollback (keď treba zasiahnuť rukou):**
    ```bash
    ssh admin@forestshop-dev.newlevel.media
    cd /srv/forestshop
    # 1. Aká verzia je práve nasadená (naživo)?
    curl -fsS https://forestshop.newlevel.media/api/version
    # 2. Aký image beží kontajner appky (tag na rollback)?
    docker inspect --format '{{.Config.Image}}' \
      "$(docker compose -f docker-compose.prod.yml ps -q app)"
    # 3. Ručný rollback na konkrétnu predošlú verziu (ak by automatika zlyhala):
    IMAGE_TAG=<predošlá-verzia> docker compose -f docker-compose.prod.yml up -d app
    # 4. Over zotavenie:
    curl -fsS https://forestshop.newlevel.media/api/version   # má hlásiť <predošlá-verzia>
    docker compose -f docker-compose.prod.yml logs --tail 50 app
    ```
    Predošlé verzie, čo sú ešte lokálne k dispozícii:
    `docker images 'ghcr.io/zbynekdrlik/forestshop-app'`. Ak sa image už
    upratal, dá sa stiahnuť späť: `IMAGE_TAG=<verzia> docker compose -f
    docker-compose.prod.yml pull app` pred `up -d app`.
- **Docker build je súčasťou CI (`docker-build` job v `ci.yml`), beží pri
  KAŽDOM push/PR**, nielen pri deploy — deploy cesta sa tak overuje ešte pred
  mergom. `.dockerignore` musí mať `**/`-prefixované vzory
  (`**/node_modules`, `**/dist`, `**/*.tsbuildinfo`, `**/playwright-report`,
  `**/test-results`) — Docker ignore semantika bez `**/` matchuje len bare
  názvy v koreni kontextu, nie v podadresároch typu `apps/api/dist`.
- **Verejný hostname `forestshop.newlevel.media` odteraz patrí tejto appke —
  VYRIEŠENÉ, issue #5, uzavreté 3. 8. 2026 (znovu overené 12. 8. 2026 pri
  issue 366, nezávisle od presunu na `forestshop-dev`).** V čase F0 ho živo
  obsluhoval súrodenský projekt `parovanie_produktov`; majiteľ 3. 8. 2026
  výslovne schválil prepnutie ("chcem prejst na novu, staru vypinam"), starú
  appku vypol sám a prepnutie bolo naživo overené (login screen, verzia v
  pätičke). Nezávislé overenie z 12. 8. 2026: Cloudflare tunnel `forestshop-app`
  (`e0cdc5bf-...`) má ingress pre `forestshop.newlevel.media` → `http://app:3000`
  už od 29. 7. 2026; DNS CNAME v zóne `newlevel.media` naň ukazuje od 3. 8. 2026
  (Cloudflare-ov vlastný `modified_on` + komentár na zázname "prepnute na novu
  appku (issue 5)"); `curl https://forestshop.newlevel.media/api/version` aj
  `curl https://forestshop-novy.newlevel.media/api/version` vracajú v tej istej
  chvíli identickú verziu — obe mená obsluhuje TÁTO appka.
- **`forestshop-novy.newlevel.media` zostáva funkčná záložná adresa** na tom
  istom tuneli/kontajneri — netreba ju mazať, `deploy.yml` overuje verziu
  proti `LIVE_HOSTNAME` (`forestshop.newlevel.media`), ale obe URL vždy
  smerujú na rovnaký bežiaci `app` kontajner.
  - **Prečo nie `novy.forestshop.newlevel.media` (pôvodne zamýšľaný tvar pre
    `forestshop-novy`)?** Cloudflare Universal SSL certifikát zóny pokrýva
    len `newlevel.media` + `*.newlevel.media` (jedna úroveň wildcard) —
    overené `openssl s_client` + SAN výpisom certifikátu; hostname o dve
    úrovne pod apexom pri TLS handshake padá (`sslv3 alert handshake
    failure`). Preto bol zvolený jednoúrovňový tvar `forestshop-novy.` priamo
    pod `newlevel.media`. Relevantné len ak v budúcnosti pribudne ďalší
    viacúrovňový hostname — vyžadovalo by to na API tokene navyše oprávnenie
    `SSL and Certificates:Edit` + zapnutý Total TLS.

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
  celý monorepo `node_modules` — na serveri sú `scripts/` len ako `rsync`-nutá kópia
  BEZ `node_modules` (final-wave-b, položka 2: prvý reálny produkčný import zapísal
  surový súbor a nemal ho čo niekedy zmazať, zväzok `catalog-raw` by rástol
  donekonečna). Kanonická implementácia preto žije v `apps/api/src/cli/
  catalog-prune-raw.ts` — `scripts/catalog-prune-raw.ts` je odteraz len jej tenký
  alias (`import "../apps/api/src/cli/catalog-prune-raw.js";`) pre lokálny
  `pnpm catalog:prune-raw`. `apps/api`'s vlastný `tsc -b` ju skompiluje do
  `apps/api/dist/cli/catalog-prune-raw.js`, ktorý Dockerfile UŽ kopíruje (celý
  `apps/api/dist`) — žiadna zmena Dockerfile nebola potrebná. Príkaz na produkcii:

  ```bash
  ssh admin@forestshop-dev.newlevel.media 'cd /srv/forestshop && docker compose -f docker-compose.prod.yml exec app node apps/api/dist/cli/catalog-prune-raw.js'
  ```

  Vypíše jednu ľudskú vetu aj JSON riadok (`{"removed": N}`) — bezpečné spustiť
  kedykoľvek (nemaže nič mladšie než 14 dní — skrátené z 30 v issue 184 —
  ani posledný prijatý súbor, pozri `pruneRawSnapshots` v `raw-store.ts`).
  Import (`catalog-ingest`) toto NEPOTREBUJE —
  beží aj cez tlačidlo na webe (`POST /api/catalog/ingest`, priamo v bežiacom
  procese appky), takže `scripts/catalog-ingest.ts` zostáva len pohodlný LOKÁLNY/CI
  vstupný bod, nie produkčná nutnosť.

- **`deploy` job (self-hosted runner) môže raz za čas zlyhať na `failed to
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
  **Diagnostika (bez zásahu do bežiacich kontajnerov iných účtov na tom
  istom serveri):**
  ```bash
  ssh admin@forestshop-dev.newlevel.media "sudo ctr --address /run/containerd/containerd.sock -n moby snapshots ls | grep <snapshot-id z chybovej hlášky>"
  ssh admin@forestshop-dev.newlevel.media "sudo ctr --address /run/containerd/containerd.sock -n moby content ls | grep <chýbajúci sha256 prefix z chybovej hlášky>"
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
  (miesto na disku) a zváž reštart `containerd`/`docker` služby na serveri.
  **Ďalší pozorovaný spúšťač TEJ ISTEJ triedy (issue 169, 2026-08-01, vtedy
  na dev2): SÚBEŽNÝ CI job na tom istom self-hosted runneri, ktorý si sám
  ťahá/spúšťa Docker image (integration/e2e job's efemérne `postgres`
  service kontajnery) presne v okamihu, keď `deploy` job extrahuje appkin
  image.** Potvrdené koreláciou časových pečiatok — `ssh
  admin@forestshop-dev.newlevel.media "journalctl -u docker --since '10 min
  ago'"` (vtedy `ssh newlevel@dev2 ...`) ukázal `image pulled ...
  postgres:16` tesne PRED aj
  PO zlyhanom `deploy`'s `failed to Lchown ...` v tej istej sekunde, a
  `gh run list --json databaseId,name,event,createdAt` potvrdil, že `CI`
  (push na `main`) a `Deploy` (push na `main`) z toho istého merge commitu
  bežali SÚČASNE. Rovnaká liečba (jeden `gh run rerun <run-id> --failed`) —
  pri rerune over `gh run list --json databaseId,name,status -q '.[] |
  select(.status!="completed")'` a `docker ps`, že žiadny INÝ CI job práve
  nebeží, aby sa race nezopakoval. Diagnostický vzor pre budúci podobný
  nález: koreluj `journalctl -u docker --since "<čas zlyhania>"` s `gh run
  list` časovými pečiatkami PRED tým, než sa dôvod hľadá v obsahu image.
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

- **Rýchla READ-ONLY kontrola produkčných dát po deployi (napr. "nezmenil
  som počet riadkov/objednávok") ide cez `postgres` službu, NIE `app`** —
  `docker compose -f docker-compose.prod.yml exec` cieli na kontajner
  bežiaci PRIAMO Postgres, appka sama nemá `psql` nainštalované:
  ```
  ssh admin@forestshop-dev.newlevel.media
  cd /srv/forestshop
  docker compose -f docker-compose.prod.yml exec -T postgres \
    psql -U forestshop -d forestshop -t -c \
    "select count(*) from order_line;"
  ```
  `"order"` je rezervované SQL kľúčové slovo (rovnaký dôvod ako
  `.claude/rules/testing.md`'s `withCleanDb()` TRUNCATE poznámka) — v
  priamom `-c` SQL stringu ho treba ručne uvodzovať (`"order"`), inak psql
  ohlási syntax error. `-t` (tuples-only) vynechá hlavičku stĺpca, takže
  výstup je priamo porovnateľné číslo. Použité pri issue 99's post-deploy
  overení, že zmena UI odkazu nezmenila žiadny riadok v `order`/`order_line`/
  `product_supplier_override`.

- **Nasadenie si po sebe maže vlastné staršie obrazy (issue 206).** dev2 je
  ZDIEĽANÝ stroj s inými projektmi a bol na 100 % disku — jedno nasadenie
  zlyhalo na `failed commit on ref "layer-sha256:…"`, čo je docker tvár
  chyby "disk plný", nie chyba obrazu. Jeden náš obraz má ~1,4 GB a
  `docker compose pull` staré tagy nikdy nemaže, takže každé nasadenie
  dovtedy nechalo po sebe ďalší. Krok `Upratať staršie obrazy TEJTO appky`
  (`.github/workflows/deploy.yml`) preto maže VÝHRADNE
  `ghcr.io/<repo>:<tag>` okrem práve nasadeného — nikdy `docker image
  prune`/`system prune`, ktoré by siahli na obrazy cudzích projektov na tom
  istom stroji. `|| true` je tam zámerne: obraz môže ešte držať dobiehajúci
  starý kontajner a nasadenie je v tej chvíli už hotové — neuprataný obraz
  nesmie zhodiť úspešný deploy. Krok beží PRED overením verzie, aby miesto
  uvoľnil ešte v tom istom behu.

- **Cloudflare tunel má VLASTNÝ proxy timeout (~100 s) na verejnom
  `forestshop-novy.newlevel.media` — dlho bežiaci manuálny POST (napr.
  supplier-stock "⚡ Spustiť teraz" nad stovkami odkazov) dostane naň
  klientsky HTTP 524, hoci appka na `app:3000` beh POKRAČUJE ĎALEJ
  server-side (issue 227, naživo overené).** Node/Hono handler nesleduje
  zatvorenie klientskeho spojenia (žiadny `req.on("close")`/abort-signal na
  tejto ceste), takže Cloudflare-ov 524 NIE JE zlyhanie behu — je to len
  strata KLIENTSKEJ odpovede. Overenie, či beh naozaj pokračuje/dobehol, ide
  MIMO tunela, priamo cez SSH na server (`.claude/rules/database.md`'s
  `postgres` service dopyt) — `pg_locks` filtrovaný na konkrétny advisory
  kľúč (`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND
  ((classid::bigint << 32) | objid::bigint) = <kľúč>;`, `1` = stále beží,
  `0` = dobehol) je spoľahlivejší dôkaz než čokoľvek, čo prehliadač po 524
  ukáže. Test na KAŽDÝ ďalší manuálny "Spustiť teraz"/dlho bežiaci POST cez
  tento tunel: neber klientsku chybu/timeout ako dôkaz zlyhania behu — over
  server-side stav (advisory zámok, `job_run`, alebo priamo cieľová
  tabuľka) predtým, než sa čokoľvek reštartuje/opakuje.

## Vývoj a produkcia bežia na TOM ISTOM 2-jadrovom stroji — 502 z preťaženia

**Výpadok 12. 8. 2026 večer (`Bad gateway Error code 502` na
`forestshop.newlevel.media`).** Príčina NEBOLA appka ani databáza: appka
odpovedala lokálne `HTTP 200` za 8 ms, kontajner sa nereštartoval
(`RestartCount=0`, `OOMKilled=false`). Padol `cloudflared` — všetky štyri
spojenia na Cloudflare edge naraz odpadli s
`TLS handshake with edge error: … i/o timeout` (`connIndex=0..3`) a znovu
sa zaregistrovali až o minútu neskôr. To NIE JE sieťová chyba — je to
hladovanie po CPU: v tom čase bežal na stroji `pnpm -r test` (plná sada
vrátane integračných testov) a `load average` vyšplhal na **13,3 pri 2
jadrách**. Tunel nestihol ani TLS handshake, takže Cloudflare nemal kam
smerovať požiadavky.

**Poučenie:** `forestshop-dev` je jediný 2-jadrový / 4 GB stroj, na ktorom
beží PRODUKCIA aj VÝVOJ. Ťažký lokálny beh (plná sada testov, build,
`pnpm -r test`) vie zhodiť produkčný tunel.

**Trvalé opatrenia (nasadené na stroji 12. 8. 2026, prežijú reštart):**

- **Prioritizácia CPU cez cgroup** — kontajnery (`system.slice`) majú
  prednosť pred vývojom (`user.slice`):

      sudo systemctl set-property user.slice CPUWeight=20
      sudo systemctl set-property system.slice CPUWeight=500

  Je to POMER, nie strop: keď produkcia nič nerobí, testy dostanú plný
  výkon; pri súbehu dostane produkcia ~96 % času. Overenie:
  `cat /sys/fs/cgroup/user.slice/cpu.weight` (má byť `20`).
- **4 GB swap** (`/swapfile`, v `/etc/fstab`, `vm.swappiness=10`
  v `/etc/sysctl.d/99-swappiness.conf`) — stroj predtým nemal žiadny a
  `kswapd0` už bol aktívny.

**Disciplína pri práci na tomto stroji:** lokálne spúšťaj len
`pnpm gates:local` (typecheck + lint + unit). `pnpm test` / `pnpm -r test`
ťahá aj integračné testy proti databáze — tie patria do CI, nie na ruku
(pozri `.claude/rules/testing.md`). Keď appka odpovedá `502`, najprv over
`cat /proc/loadavg` a `docker logs forestshop-cloudflared-1 | grep -i
"handshake"`, až potom hľadaj chybu v kóde.

- **Cloudflare kešuje statické cesty na okraji — a cesta, ktorá PREDTÝM
  padala na SPA fallback (napr. `/favicon.ico` → `index.html`, `text/html`),
  drží STARÚ odpoveď aj po nasadení skutočného súboru** (issue 430, overené
  naživo). Po nasadení favicony vracal `/favicon.ico` cez CF stále
  `text/html` (`cf-cache-status: HIT`, `last-modified` z PRED nasadenia),
  hoci origin už servíroval správny obrázok. **Diagnostika:** origin over
  cache-busterom `curl -s -o /dev/null -w "%{content_type}"
  "https://forestshop.newlevel.media/favicon.ico?cb=$(date +%s)"` (querystring
  = iný CF cache kľúč → čerstvá odpoveď z originu) — ak vráti `image/x-icon`,
  je to čisto stará CF keš, appka je v poriadku. NOVÉ cesty (`/favicon.svg`,
  `/favicon-32.png`, `/apple-touch-icon.png`) nikdy neboli kešované, takže
  idú hneď správne — problém je LEN pri ceste, čo existovala už predtým.
  **Pracovný token `CF_API_TOKEN` (`/srv/forestshop/.env`) NEMÁ právo Cache
  Purge** (má len Tunnel + DNS Write + Zone Read) — `POST
  /zones/<zone>/purge_cache` vráti `Authentication error`. Keš sa aj tak sama
  vyprázdni podľa `max-age` (favicon `14400` s = 4 h). Moderné prehliadače
  aj tak berú favicon z `<link rel="icon" type="image/svg+xml">` (`/favicon.svg`,
  servírovaný správne), takže karta ukazuje ikonu okamžite; stará keš
  `/favicon.ico` je len kozmetika, ktorá do ~4 h zmizne. Ak by bolo treba
  purge hneď, vytvor purge-schopný token zo správcovského tokenu
  (`.claude` memory `cloudflare-access`) — na 3-hodinovú self-healing keš to
  ale zvyčajne nestojí za nový prod token.
