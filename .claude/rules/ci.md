---
paths:
  - ".github/workflows/ci.yml"
  - "apps/web/vite.config.ts"
---

# CI gotchas

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
