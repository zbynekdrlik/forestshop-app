---
paths:
  - "apps/api/src/modules/shoptet-writeback/**"
  - "apps/api/tests/shoptet-writeback-*.integration.test.ts"
  - "apps/api/tests/order-note-*.integration.test.ts"
  - "apps/api/tests/helpers/shoptet-fixture.ts"
  - "apps/api/tests/helpers/shoptet-order-detail-fixture.ts"
  - "Dockerfile"
---

# Shoptet spätný zápis (issue 122)

- **Reálne Shoptet admin cesty pre `www.forestshop.sk` (overené naživo pri
  návrhu #122):** prihlasovacia stránka JE `${SHOPTET_ADMIN_BASE_URL}/admin/`
  (žiadna samostatná `/login` cesta), import formulár
  `${base}/admin/import-produktov/`, log importov
  `${base}/admin/import-produktov/log/`. Zdroj: dry-run sesterského
  `parovanie_produktov`'s `scripts/shoptet_import.py` proti produkcii.
- **Úspešné aj neúspešné prihlásenie skončí na TEJ ISTEJ URL
  (`${base}/admin/`) — substring na URL ("/login") NEROZLÍŠI úspech od
  zlyhania pre tento konkrétny obchod.** Jediný spoľahlivý signál:
  prítomnosť prihlasovacieho formulára (placeholder "E-mail") PO odoslaní
  — ak je stále vidieť, prihlásenie zlyhalo. Rovnaký test pri akejkoľvek
  ďalšej automatizácii admin prihlásenia.
- **KRITICKÉ: priamy `locator.setInputFiles()` na skrytý (`hidden`) file
  input NEFUNGUJE proti reálnemu Shoptetu.** Import formulár je React
  komponent (`data-testid="inputFileUpload"`, `hidden`), ktorého vlastný
  "súbor vybraný" JS stav je naviazaný na natívny file-chooser dialóg
  spustený VIDITEĽNÝM tlačidlom "Vyberte súbor" (`<button
  onclick="...">`/label-for vzor), nie na `change` event skrytého inputu.
  Priamy `setInputFiles` DOM update prejde (input.files sa naplní), ale
  widget o tom nevie → klik na `buttonImport` (submit) sa nikdy neodošle,
  `page.waitForURL(...)` timeoutuje po 120s bez chyby predtým. Rovnaké
  zistenie ako sesterský `parovanie_produktov`'s `_do_import` komentár
  ("Shoptet widget inak súbor nezaregistruje") — fix je vždy: `const p =
  page.waitForEvent("filechooser"); await
  page.locator('button:has-text("Vyberte súbor")').first().click(); const
  fc = await p; await fc.setFiles(path);`. **Fixture (`shoptet-
  fixture.ts`) musí mať RIADENÝ tento istý tvar** (skrytý input + viditeľné
  tlačidlo s `onclick` na `.click()` skrytého inputu), inak testy proti
  fixture prejdú aj so ZLOU (priamou `setInputFiles`) implementáciou —
  presne to sa stalo tu, odhalené AŽ pri naživo overovaní na produkcii.
  **Test na KAŽDÝ ďalší podobný "štýlovaný upload" formulár:** over naživo
  proti reálnemu cieľu skôr, než len proti fixture — fixture môže byť
  príliš zhovievavá.
- **Alpine (produkčný Docker image) nemá Playwright's vlastný stiahnutý
  Chromium (glibc-only, na musl libc nikdy nenaštartuje).** Fix:
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` v OBOCH Docker štádiách (build aj
  runtime) + `apk add --no-cache chromium nss freetype freetype-dev
  harfbuzz ca-certificates ttf-freefont` v runtime štádiu.
  `resolveChromiumExecutablePath()` (`playwright-import.ts`) hľadá
  `/usr/bin/chromium-browser` potom `/usr/bin/chromium`, override cez
  `CHROMIUM_EXECUTABLE_PATH` env. Launch args MUSIA obsahovať `--no-
  sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu`
  (kontajner beží ako non-root `node`, žiadny GPU). Over TÝMTO vzorom pred
  spoliehaním sa naň (throwaway `node:24-alpine` kontajner, `apk add
  chromium` + `playwright`'s `chromium.launch({executablePath})` proti
  nemu — funguje, overené naživo pri návrhu #122).
- **Race medzi `select-changes` (číta, čo sa zmenilo) a `mark-synced`
  (zapisuje `synced_at`) — Playwright beh môže trvať desiatky sekúnd až
  ~2 minúty.** Keby sa TEN ISTÝ override upravil znova PO výbere, ale PRED
  označením ako synchronizovaný, naivné "označ podľa productKey"
  by tú novšiu úpravu stratilo (poslala sa len staršia hodnota, ale
  označilo by sa to ako "všetko OK"). Fix: `mark-synced` dostáva `now` =
  ČAS ZAČIATKU CELÉHO BEHU (od schedulera, PRED výberom) a UPDATE má
  navyše `updatedAt <= now` — úprava po štarte behu má nutne `updatedAt >
  now`, takže sa neoznačí a ďalší beh ju pošle znova. Rovnaký test pri
  KAŽDOM ďalšom "vyber → dlho bežiaci externý zápis → označ hotové" vzore:
  zachyť "now" PRED výberom, filtruj podľa neho pri označovaní, nie len
  podľa zoznamu id-čiek.
- **Ručné spustenie joba na produkcii BEZ pridávania manuálneho HTTP
  endpointu (ktorý ticket nechcel):** skopíruj malý `.mjs` skript, ktorý
  importuje UŽ SKOMPILOVANÉ `apps/api/dist/...` moduly, do `apps/api/`
  PRIEČINKA vnútri bežiaceho kontajnera (`docker cp` + `docker exec -w
  /app/apps/api node script.mjs`) — Node-ova ESM rezolúcia `playwright`
  balíka funguje LEN odtiaľ (`/app/apps/api/node_modules/playwright`
  existuje, `/app/node_modules/playwright` nie — len `.pnpm` store). Skript
  vytvorený mimo `/app/apps/api/` (napr. `/tmp/`) vôbec nenájde
  `playwright` balík. Po overení skript zmazať (`docker exec -u root
  ... rm`, súbory nakopírované cez `docker cp` patria rootovi, `node`
  užívateľ ich nezmaže).
- **Čítanie Shoptetovho reálneho CSV exportu na overenie (mimo appky,
  napr. pri live-acceptance kontrole) potrebuje `encoding="cp1250"`, NIE
  UTF-8** — Shoptet exportuje v Windows-1250 (obsahuje diakritiku ako
  bajty mimo ASCII), `open(..., encoding="utf-8")`/plain `grep` (bez `-a`)
  ticho zlyhá/nič nenájde na takom súbore. Použi `grep -a` na rýchlu
  kontrolu, `python3`'s `csv` modul s `encoding="cp1250"` na presné
  vytiahnutie stĺpca podľa mena (hlavička má `code`, `pairCode`,
  `internalNote` medzi ~265 stĺpcami).
- **Nová `hourly` naplánovaná úloha s injektovanou closure (rovnaký vzor
  ako `catalogImportJob`/`ordersImportJob`) = `RunX` typ + `xJob(runX:
  RunX | undefined)` v `jobs.ts`, zostavená closure v `index.ts` z
  `env.ts`'s nepovinných premenných.** `shoptetWritebackJob` beží na `:50`
  (mimo kolízie s `ordersImportJob`'s `:45`), žiadny nový advisory lock
  (žiadny manuálny trigger v tomto tickete, s ničím nepreteká).
