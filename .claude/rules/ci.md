---
paths:
  - ".github/workflows/ci.yml"
  - "apps/web/vite.config.ts"
---

# CI gotchas

- **`integration`, `e2e` a `docker-build` joby MUSIA ostať BEZPODMIENEČNÉ
  (žiadne `if:`, žiadne `continue-on-error`) na KAŽDOM push/PR do `dev` aj
  `main` — issue 351 na tom stojí celý plán.** Od issue 351 sa tieto dve
  brány (postgres + skutočný prehliadač) na dev1 lokálne default NESPÚŠŤAJÚ
  (`.claude/rules/local-dev.md`'s `pnpm gates:local`) presne preto, že
  `ci.yml` ich aj tak zakaždým odbeží znova, zadarmo (verejné repo,
  `ubuntu-latest`). Keby sa niektorá z nich stala podmienenou/voliteľnou,
  vznikne diera v pokrytí bez toho, aby to bolo vidno lokálne. `version-
  check`'s `if: github.ref_name != 'main'` je jediná zámerná výnimka
  (netýka sa testovacích brán, len toho, že na `main` nemá zmysel).
- **`pnpm/action-setup@v4` sa v `ci.yml` volá BEZ `version:` inputu.**
  `package.json` má `packageManager: "pnpm@10.0.0"` — keď action dostane aj
  explicitný `version` input aj nájde `packageManager`, zlyhá s "Multiple
  versions of pnpm specified". Ak niekedy treba inú pnpm verziu, zmeň
  `packageManager`, nikdy nepridávaj `version:` k `pnpm/action-setup`.
- **`apps/web/vite.config.ts` musí mať `server.host: "127.0.0.1"`
  explicitne.** Bez toho Vite defaultne bindne na literálny string
  `"localhost"`, ktorý Node vyrieši JEDNOU DNS lookup — na GitHub Actions
  ubuntu runneroch sa to rozrieši len na IPv6 `::1`, zatiaľ čo
  `playwright.config.ts` (webServer readiness aj `baseURL`) mieri na
  `127.0.0.1`. Výsledok: appka beží a hlási sa ako pripravená, ale každý
  connect na `127.0.0.1` dostane okamžité `ECONNREFUSED`, až kým
  `webServer.timeout` (60s) nevzdá. Lokálne sa to nikdy neukázalo (tu sa
  `"localhost"` rozrieši na `127.0.0.1` ako prvé) — čisto rozdiel v poradí
  DNS/`getaddrinfo` na danom stroji, nie flaky test. Ak sa niekedy timeout e2e
  jobu znova objaví len na CI a nie lokálne, over TOTO ako prvé, predtým než
  sa timeout predlžuje — predlžovanie timeoutu by nič nevyriešilo (spojenie sa
  odmieta okamžite, nie pomaly).
- **Verziu na porovnanie `dev` vs `main` NIKDY neraď cez `sort -V`.** GNU
  `sort -V` radí predvydania NAD finálnu verziu (`0.2.0` < `0.2.0-dev.1`),
  semver to má presne naopak. Po každom mergi zostane na `main` posledná
  `-dev` verzia, takže brána `version-check` padala na správne zvýšenej verzii
  (`dev=0.2.0 main=0.2.0-dev.1` → falošné zlyhanie). Radenie robí
  `npx --yes semver@7.6.3 "$main_v" "$dev_v" | tail -1` (pinutá verzia,
  posledný riadok = najvyššia). To isté platí pre akékoľvek ďalšie porovnanie
  verzií v skriptoch — `sort -V` je použiteľné len tam, kde predvydania
  nevznikajú.
- Console-assert výnimka pre e2e testy (jediná povolená: neautentifikovaný
  `/api/me` 401) je popísaná v `.claude/rules/testing.md` — rozširovanie tejto
  výnimky je zakázané, nie len pri práci na CI configu.
- **`gh pr merge <N> --merge` môže vrátiť GraphQL chybu ("Something went
  wrong…"), a PRESTO na strane servera čiastočne uspieť** — `main`'s ref sa
  posunie na skutočný merge commit (over: `gh api repos/…/git/ref/heads/main`
  aj `git diff origin/main origin/dev`, mal by byť prázdny), ale PR objekt
  ostane `state: open, merged: false` a — kriticky — **commit nedostane ani
  jeden check-suite/check-run/status vôbec** (`gh api repos/…/commits/<sha>/
  check-suites` prázdne). Keďže ani `ci.yml` ani `deploy.yml` nemajú
  `workflow_dispatch`, takýto commit sa NIKDY nespustí spätne — opakovaný
  `gh pr merge`/`--auto` už len hlási "not mergeable: dirty" (obsah je
  identický, niet čo mergovať) a re-request check-suite nemá čo re-requestnúť
  (žiadny neexistuje). **Recovery:** over najprv `git diff origin/main
  origin/dev` (prázdny = obsah je v `main` v poriadku), zavri stary PR ručne s
  komentárom vysvetľujúcim situáciu (`gh pr comment` + `gh pr close`, NIKDY
  force-push/prepis `main`), a nechaj CI+Deploy dobehnúť cez ĎALŠÍ, úplne
  bežný malý commit na `dev` (napr. plánovaný playbook/log zápis) — jeho push
  na `main` spustí normálny beh nad CELÝM aktuálnym stromom, teda aj nad
  obsahom, ktorý "zaskočil" bez CI.
- **`ci.yml` beží LEN na `push` (do `dev` aj `main`) — `pull_request` trigger je
  ZÁMERNE VYNECHANÝ (issue 458, opravené). NEPRIDÁVAJ ho späť.** Kým tam bol,
  každý `dev→main` PR spustil DVA behy nad tým istým head commitom (`event=push`
  + `event=pull_request`), ktoré súťažili o runner sloty a jeden
  `e2e`/`integration` zamrzol na neurčito (~20 min vs normál ~2 min). **Prečo NIE
  concurrency-cancel toho dvojbehu** (prvý pokus, zavrhnutý): zjednotiť push+PR
  beh do jednej `concurrency` skupiny a jeden zrušiť sa zdá lákavé, ale zrušený
  beh nechá **CANCELLED check na tom istom head SHA** ako zelený beh (checky push
  aj PR behu sedia na jednom SHA) → PR ostane natrvalo **UNSTABLE** (overené
  naživo na PR #459: `mergeable=MERGEABLE`, `mergeStateStatus=UNSTABLE`; branch
  protection síce berie najnovší check per meno, ale RAW rollup/mergeStateStatus
  ráta aj CANCELLED). To je presne to, pred čím issue 458 varovalo. **Riešenie —
  duplikát NEVYTVORIŤ:** push beh nad head commitom `dev`-u reportuje checky
  priamo na PR (GitHub páruje checky podľa **SHA, nie eventu**), takže PR je
  CLEAN pri JEDNOM behu. **Prečo to nevytvorí dieru v pokrytí:** každá zmena na
  `dev` ide cez `dev→main` PR, ktorého head je pushnutý dev commit → push beh nad
  ním odbehne VŠETKY brány; `if:`/`continue-on-error` sa nepridáva → „brány
  bezpodmienečne na každom push do dev aj main" (issue 351 vyššie) ostáva
  splnené. **`concurrency` skupina** (`${{ github.workflow }}-${{ github.head_ref
  || github.ref_name }}`, `cancel-in-progress: true`) ostáva len na zrušenie
  PREDBEHNUTÝCH (starších) behov tej istej vetvy pri rýchlych pushoch — ruší
  STARŠIE commity, nie head PR-ka, takže PR ostáva CLEAN. Deploy workflow má
  vlastnú skupinu `deploy` (`cancel-in-progress: false` = radí, neruší) — tejto
  zmeny sa netýka.
- **`playwright install --with-deps chromium` v `integration`/`e2e` joboch vie
  na GitHub-hosted runneri OJEDINELE ZAMRZNÚŤ** (sťahovanie Chromium z playwright
  CDN + `apt-get` deps) — pozorované ~19 min na tom istom kroku (7/13) v OBOCH
  joboch naraz (spoločný CDN výpadok), zatiaľ čo predošlý beh toho istého SHA ten
  krok prešiel za pár sekúnd. Je to transient infra (nie contention — po oprave
  458 beží len JEDEN beh; nie kódová chyba — install krok sa diffom nedotýka).
  **Postup:** zruš zamrznutý beh (`gh run cancel <id>`, počkaj na `completed
  cancelled`), potom `gh run rerun <id>` — čerstvý runner install prejde. JEDEN
  rerun na vylúčenie transientu je v poriadku; NEPREDLŽUJ timeout (nie je pomalý,
  zdroj visí externe).
  **issue 460 (trvalá odolnosť, nasadené):** oba joby teraz cacheujú stiahnutý
  Chromium cez `actions/cache@v4` (`~/.cache/ms-playwright`, kľúč
  `${{ runner.os }}-playwright-<verzia>`) — na cache-HIT beží len
  `playwright install-deps chromium` (apt), sťahovanie z CDN sa preskočí, čím
  symptóm #1 (CDN zamrznutie) prakticky zmizne. Ak sa cache MINIE (bump
  Playwrightu / prvý beh), plná `--with-deps` inštalácia môže stále OJEDINELE
  zamrznúť na CDN — vtedy platí cancel+rerun postup vyššie, ale je to už len
  pri invalidácii cache, nie pri každom behu.
- **Reálny-Chromium integračné testy majú per-`it` strop `TEST_TIMEOUT_MS =
  120_000` (issue 460), NIE 60 s.** Súbory `shoptet-writeback-run/-playwright/
  -sequence`, `dpd-pickup-playwright`, `dpd-shipment-playwright`,
  `order-note-playwright` ženú reálny Chromium proti fixture (~16 s baseline —
  merané zo súrodencov 16,1–16,3 s). Pri pôvodnom 60 s strope (~4× rezerva)
  test `shoptet-writeback-run:54` ojedinele timeoutoval na pomalom hostenom
  runneri (beh `32285918063` attempt 1) — nie regresia, runner-timing flake.
  120 s = ~8× rezerva, cielene LEN na prehliadačové testy; DB-only testy
  ostávajú na globálnom `testTimeout: 30_000` (`vitest.config.ts`). Nový
  reálny-Chromium test drž na `TEST_TIMEOUT_MS = 120_000`, nie 60 s.
