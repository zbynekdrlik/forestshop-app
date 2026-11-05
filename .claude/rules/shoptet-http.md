---
paths:
  - "apps/api/src/modules/shoptet-http/**"
  - "apps/api/src/modules/scheduler/restock-block-retry.ts"
  - "apps/api/src/read-bounded.ts"
  - "apps/api/tests/restock-block-retry.integration.test.ts"
  - "apps/api/tests/scheduler-shoptet-tally.integration.test.ts"
---

# Požiadavky na forestshop.sk a blok Shoptetu (issue 598)

- **Od 21. 10. 2026 Shoptet WAF (openresty) každé ráno blokuje IP servera
  `forestshop-dev` — na KAŽDÚ požiadavku na forestshop.sk (verejné stránky,
  exporty s `hash=`, aj administráciu) vráti HTTP 403 so stránkou „Access
  temporarily blocked — … suspicious activity that looked like an attack“.**
  Okno ~04:15–08:00, 25. 10. ešte o 08:56. Spúšťač bol náš `shop-sitemap`
  (900 s sond každú noc, viď `shop-sitemap.md`), nie zmena našej prevádzky — Shoptet
  21. 10. sprísnil prah. Skutočná stránka je fixtúra
  `modules/shoptet-http/fixtures/shoptet-block-page.html` (IP nahradená 203.0.113.7).
- **KAŽDÝ HTTP fetcher na forestshop.sk ide cez `shoptetFetch(url, init, context)`
  (`modules/shoptet-http/fetch.ts`), nikdy priamy `fetch()`.** Dnes: sitemap,
  sonda kandidátov, feed `google.xml`, export katalógu, oba exporty objednávok.
  `shoptetFetch` (1) zmení blokovú stránku na `ShoptetBlockedError` so správou
  `shoptet_blocked: …` (bežnú 403/404 vráti nezmenenú — telo číta cez `clone()`,
  volajúci ho vie čítať ďalej), (2) započíta požiadavku do počítadla behu. URL sa
  nikdy neloguje (exporty nesú prihlasovací údaj), len `context`. Nový fetcher na
  e-shop = `shoptetFetch`, inak ho blok aj počítadlo minú.
- **Rozpoznanie bloku stojí na PREDPONE správy `shoptet_blocked:`
  (`isShoptetBlockedError`/`isShoptetBlockedMessage`), nie len na `instanceof`.**
  Playwright prihlásenie (`shoptet-writeback/admin-login.ts`) beží v dieťa
  procese (`child-runner.ts`) a chyba k rodičovi prichádza len ako text. Rovnaká
  predpona v `job_run.error_message` je to, z čoho `restock-block-retry.ts`
  odvodzuje „posledný beh bol zablokovaný".
- **`job_run.detail` nesie `shoptetRequests` / `shoptetBlocked` /
  `shoptetAdminSessions`** (len nenulové; aj pri `failure`). Počítadlo je
  `AsyncLocalStorage` (`request-tally.ts`) — `scheduler.ts`'s `executeJob` aj
  `run-now.ts`'s `startRunNow` obalia `run()` VLASTNÝM počítadlom, takže reťaz
  spustená zvnútra iného behu (restock po supplier-stocku) sa nezapočíta rodičovi.
  Playwright relácie (`runShoptetImportIsolated`, `runOrderNoteWritebackIsolated`)
  sa počítajú ako `adminSessions` — požiadavky prehliadača v dieťa procese nie.
  Dopyt „kto zaťažuje e-shop": `select job_name, sum((detail->>'shoptetRequests')::int)
  from job_run where started_at > now()-interval '1 day' group by 1`.
- **`readBounded` žije v `src/read-bounded.ts`** (nie v `catalog/fetcher.ts`) —
  `shoptet-http/fetch.ts` ho potrebuje a `catalog/fetcher.ts` importuje
  `shoptet-http/fetch.ts`; ponechaný v katalógu by vyrobil cyklický import.
- **Restock pri bloku (`modules/scheduler/restock-block-retry.ts`):** zablokovaný
  beh (04:50, reťaz po supplier-stocku, aj samotné opakovanie) → `observe` naplánuje
  JEDNO opakovanie o 60 min (ďalšie zablokované behy v tom čase nové nepridávajú)
  cez `startRunNow` + `RESTOCK_RUN_LOCK_KEY` (`runRestockLockedFn`, odomknutý),
  `trigger: "retry-after-shoptet-block"`. Pred spustením si overí v `job_run`, že
  posledný restock je STÁLE zablokovaný (medzičasom úspešný beh → nič). Keď by
  ďalší pokus začal o 12:00 miestneho času alebo neskôr → karta
  `shoptet_blokovanie` (`upsertUpozornenie`, dedupKey `restock:shoptet-blokovane`,
  odkaz `/?tab=restock`). Úspešný beh (aj `nothing_to_do`) kartu zatvorí
  (`autoResolveByDedupKey`); vypnutý restock (`skip`) sa nepozoruje. VŠETKY štyri
  cesty (04:50, reťaz, opakovanie, ručné „Spustiť teraz" v `http/restock-routes.ts`
  cez `RestockRunDeps.observe`) idú cez `runObservedRestock` (`jobs.ts`) — review
  našiel, že ručný beh pôvodne obchádzal pozorovateľa: opakovanie, čo narazí na
  `busy` počas ručného behu, sa spolieha na to, že ručný beh výsledok pozoruje, inak
  by reťaz opakovaní skončila bez karty. Počet pokusov na karte = skoršie zablokované
  `job_run` riadky dnes + 1 (pozorovaný beh ešte nie je zapísaný ako failure).
  Budík je len v pamäti — `index.ts` po štarte volá `resume()`, ktorý ho obnoví z
  `job_run` (deploy počas okna opakovaní nič nestratí); po uplynutí okna `resume()`
  kartu ZNOVA NEZAKLADÁ (každý popoludňajší deploy by ju inak obnovil, po vybavení
  majiteľom dokonca založil novú). Shutdown zastaví budík spolu s plánovačom.
- **Testy nikdy nejdú na živý e-shop:** unit testy stubujú `fetch` cez
  `vi.stubGlobal` a vracajú `new Response(BLOCK_PAGE, {status: 403})`;
  `startShoptetFixture({ blocked: true })` (`tests/helpers/shoptet-fixture.ts`)
  vráti blokovú stránku na každú požiadavku pre Playwright test. Testovací kľúč
  zámku `787_878_102` (`scheduler-shoptet-tally.integration.test.ts`). Na boxe
  `forestshop-dev` (je to PROD a jeho IP je blokovaná) pri diagnostike najviac
  jedna-dve ručné požiadavky na forestshop.sk, mimo 04–08.
