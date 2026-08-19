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
- **Concurrency kľúč `ci.yml` MUSÍ zjednotiť `push` aj `pull_request` beh tej
  istej ZDROJOVEJ vetvy — kľúčuj na `${{ github.head_ref || github.ref_name }}`,
  NIKDY na `github.ref` ani `github.sha` (issue 458, opravené).** Každý
  `dev→main` PR spúšťa DVA CI behy nad tým istým head commitom: `event=push`
  (push do `dev`) + `event=pull_request` (otvorenie/synchronize PR). Aby ich
  `cancel-in-progress` zlúčil na JEDEN beh, potrebujú ROVNAKÝ concurrency kľúč —
  a jediný výraz s rovnakou hodnotou pre obe udalosti tej istej vetvy je
  zdrojová vetva: `github.head_ref` (nastavené len pri `pull_request`, = zdrojová
  vetva) `|| github.ref_name` (krátky názov vetvy pri `push`) → `CI-dev` pre
  obe. **Prečo NIE `github.ref`** (predošlý, neúčinný kľúč): pri `push` je
  `refs/heads/dev`, pri `pull_request` `refs/pull/N/merge` — dva RÔZNE reťazce →
  dve skupiny → dvojbeh + contention. **Prečo NIE `github.sha`:** pri
  `pull_request` je to SHA efemérneho merge commitu, pri `push` head SHA — opäť
  sa nezhodnú. Symptóm neúčinného kľúča: `e2e`/`integration` dvoch súbežných
  behov toho istého commitu sútažia o runner sloty a jeden `e2e` zamrzne na
  neurčito (~20 min vs normál ~2 min). **Diagnostika starého stavu:** ak
  identický SHA prešiel v druhom behu → contention, nie zlyhanie testu;
  NEPREDLŽUJ timeout (`no-timeout-band-aids`). **Prečo dedup nevytvorí dieru v
  pokrytí:** cancel zruší len REDUNDANTNÝ druhý beh toho istého commitu — všetky
  brány (`e2e`/`integration`/`docker-build`) aj tak odbehnú raz na tom commite
  cez beh, ktorý prežije (najnovší); `if:`/`continue-on-error` sa nepridáva, tak
  že požiadavka „brány bezpodmienečné na každom push/PR" (issue 351 vyššie)
  ostáva splnená. **Prečo PR neostane UNSTABLE:** oba behy pripájajú check-runy
  na ten istý head SHA PR-ka a branch protection berie NAJNOVŠÍ check-run daného
  mena — prežije novší (zelený) beh, takže PR skončí CLEAN nech prežil push či
  PR beh. Deploy workflow má vlastnú skupinu `deploy` (`cancel-in-progress:
  false` = radí, neruší) — tejto zmeny sa netýka.
