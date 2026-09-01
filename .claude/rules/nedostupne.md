---
paths:
  - "apps/api/src/modules/nedostupne/**"
  - "apps/api/src/http/nedostupne-routes.ts"
  - "apps/web/src/components/NedostupneSection*.tsx"
  - "apps/web/src/components/NedostupneOrderNote.tsx"
  - "apps/web/src/nedostupneApi.ts"
  - "apps/web/src/useNedostupneResolved.ts"
  - "apps/api/src/modules/single-use-preview-tokens.ts"
  - "apps/api/src/modules/orders/merge-mail-preview-tokens.ts"
  - "apps/api/src/modules/orders/customer-contact-preview-tokens.ts"
---

# Nedostupné tovary (issue 176)

- **Server-side vynútenie povinného náhľadu — jednorazový `previewToken`,
  nikdy len UI konvencia.** Prvá verzia (merge candidate) spoliehala len na
  to, že React komponent volá `/preview` PRED zobrazením tlačidla "Odoslať"
  — `/send` samotné nič nekontrolovalo, takže priame API volanie mohlo
  poslať e-mail bez toho, aby čokoľvek jeho obsah niekedy zobrazilo (nájdené
  code review PRED mergom PR #182, nie testom). Oprava: `preview-tokens.ts`
  vydá krátkodobý (15 min), JEDNORAZOVÝ token viazaný na presne (orderCode,
  variantCode, emailType) pri `/preview`; `/send` ho vyžaduje a KONZUMUJE
  (zmaže) PRED čímkoľvek iným, bez ohľadu na výsledok zhody. Rovnaký
  in-process `Map` vzor ako `login-rate-limit.ts` (jedna bežiaca inštancia,
  MVP rozsah — reštart appky tokeny zruší, v poriadku). Ďalšia automatizácia
  s ticketovou podmienkou "povinný náhľad pred odoslaním" potrebuje TEN ISTÝ
  mechanizmus, nie len frontend disciplínu.
- **issue 505: jadro jednorazových preview-tokenov je ZDIEĽANÉ v
  `apps/api/src/modules/single-use-preview-tokens.ts`** (factory
  `createSingleUsePreviewTokenStore()` → `{ issue(key, now), consume(token,
  key, now) }`, kľúčovaný ĽUBOVOĽNÝM reťazcom). Tri moduly, čo ho volajú, sú
  už len TENKÉ WRAPPERY so zachovanými verejnými signatúrami:
  `nedostupne/preview-tokens.ts`, `orders/merge-mail-preview-tokens.ts`,
  `orders/customer-contact-preview-tokens.ts`. **TTL (15 min), `MAX_ENTRIES`
  strop, sweep interval a eviction sa menia na JEDNOM mieste** (v zdieľanom
  jadre), nie trikrát. Každý wrapper má VLASTNÝ store (nezdieľaný Map + strop),
  takže eviction jednej feature nevyhadzuje tokeny inej. Viac-poľové kľúče vo
  wrapperi serializuj cez `JSON.stringify([...])` (nie `join(oddeľovač)`,
  ktorý pri hodnote s oddeľovačom kolidoval) — je injektívny, takže porovnanie
  reťazcového kľúča je ekvivalentné pôvodnému porovnaniu po poliach. Nová
  automatizácia s povinným náhľadom = nový tenký wrapper nad týmto jadrom.
- **ŽIADNY scheduler/`enabled` prepínač, na rozdiel od #172/#173** — táto
  automatizácia nemá žiadny naplánovaný beh (ticket nič také nežiadal).
  `GET /api/nedostupne` je VŽDY živý DB dopyt, nikdy `job_run.detail` cache.
  Jednoduchšie, žiadna zbytočná zložitosť (MVP) — nová podobná automatizácia
  BEZ plánovaného behu by mala rovnako vynechať settings/`job_run` vrstvu.
- **PREKONANÉ issue 238-om (2026-08-04, ponechané pre históriu): `product.
  related_codes` (text[]) — automatický návrh náhrady zo Shoptetu (CSV
  `relatedProduct`/`relatedProduct2..8`, `catalog/map-row.ts`'s
  `extractRelatedCodes`/`MAX_ALTERNATIVES=8`), s `alternativeSearchUrl`
  vyhľadávacím fallbackom, keď appka nemala skutočnú produktovú URL.**
  Majiteľ tento CELÝ mechanizmus zamietol: *"nechcem aby to uvádzalo tieto
  náhrady - je to blbosť, to sú súvisiace produkty - nie podobné, nie
  náhrady"*. Nahradené RUČNÝMI odkazmi (bod nižšie). **issue 245 (2026-08-05)
  dokončilo follow-up: `product.related_codes` stĺpec + celé jeho populovanie
  (`map-row.ts`'s `extractRelatedCodes`/`RELATED_COLUMNS`/`MAX_ALTERNATIVES`,
  `ingest.ts`'s insert/upsert) sú ÚPLNE ODSTRÁNENÉ (incremental migrácia
  `0033_breezy_manta.sql`) — v kóde už neexistujú vôbec, nielen nečítané.
- **issue 238: majiteľove RUČNE vložené odkazy náhrad —
  `nedostupne_replacement_link` (`variant_code` PLAIN text bez FK, rovnaká
  konvencia ako `nedostupne_state`; `url`; ŽIADNY unique index).** Kľúčované
  VARIANTOM (nie `product.key` ako `product_supplier_link_override`) — screen
  aj e-mail sú per-variant granularita (`NedostupneGroup`), majiteľov nákres
  dáva pole PRI KAŽDOM TOVARE (skupina), nie pri každom čakajúcom
  zákazníckom riadku. Viac riadkov s rovnakým `variant_code` = zoznam liniek
  (`modules/nedostupne/replacement-links.ts`, zoradené `asc(createdAt)` —
  poradie vloženia, prvý pridaný je zvyčajne najviac odporúčaný). Appka k
  ručne vloženému odkazu nepozná žiadny názov/kód produktu, preto e-mailový
  `zoznam_nahrad`'s `label` je SAMOTNÁ url (`logic.ts`'s
  `buildAlternativeEmail`). Prežije nočný katalógový reimport bez ďalšej
  práce — import sa tejto tabuľky vôbec nedotýka (rovnaký zámer ako
  `nedostupne_state`/`mail_template`).
- **issue 238: preklik na náš e-shop (názov produktu) NEPOUŽÍVA
  `shopLinks.ts`'s `ourProductLink` vyhľadávací fallback, na rozdiel od
  `restock` obrazovky** — ticket žiada explicitne "ak adresu nemáme, názov
  ostane neaktívny, nikdy nevyrábať odhadom", takže `queries.ts` číta priamo
  `shop_product_url.url` (LEFT JOIN podľa `variantCode`) a frontend
  vykreslí `<a>` LEN keď nie je `null`, inak plain text. Preklik na kód
  produktu (dodávateľ) naopak ZDIEĽA existujúcu `resolveEffectiveSupplierLink`
  (`orders/effective-supplier-link.ts`) — rovnaká funkcia ako "Na
  objednanie", žiadna duplicitná logika.
- **Dedup (`nedostupne_state`) je serializovaný `NEDOSTUPNE_SEND_LOCK_KEY`
  (`787_878_006`) — bez zámku by dva súbežné klik-y na TEN ISTÝ (objednávka,
  variant, typ) mohli OBA prejsť dedup-check pred zápisom a poslať e-mail
  DVAKRÁT** (nájdené vlastným code review pred mergom). Rovnaký vzor ako
  #172/#173's RUN lock, len okolo jedného odoslania namiesto celého behu.
  `.claude/rules/scheduler.md`'s registry MUSÍ byť aktualizovaný pri KAŽDOM
  novom kľúči — 005 (`order-reminder`) aj 006 (toto issue) tam predtým
  chýbali, hoci kód sám kolízii predišiel správne.
- **`insertTestVariantForProduct` (`tests/helpers/orders.ts`) NEMÁ od issue 245
  `relatedCodes` voľbu — odstránená spolu s celým `product.related_codes`
  stĺpcom (žiadny existujúci test ju reálne používal).**
- **issue 277: `MailPreviewDialog.tsx` (zdieľaná s "Zlúčenie objednávok",
  `.claude/rules/orders.md`) prestala byť READ-ONLY — telo je editovateľná
  `<textarea>` (`bodyText`/`onBodyTextChange`), predvyplnená
  `RenderedEmail.text` (appka ju už počítala od issue 192, len ju
  nikam neposielala). Predmet/príjemca zostávajú needitovateľné.**
  `sendNedostupneEmail`'s nový voliteľný `editedBody` PREPÍŠE
  `html`/`text` tesne pred odoslaním (`renderEditedBody`,
  `mail-templates/render.ts` — plain text → escapovaný HTML, ŽIADEN
  `{{pole}}`/`**tučné**` engine druhýkrát), predmet ostáva z
  NEUPRAVENÉHO vyrenderovania. Šablóna v `mail_template` sa touto
  editáciou nikdy nemení — číta sa len na zostavenie predmetu
  (integračný test `mail-edited-body.integration.test.ts` to dokazuje
  bajt-na-bajt porovnaním riadku pred/po odoslaní). Server-side sa
  editovaný text VALIDUJE len minimálne (`z.string().trim().min(1)
  .max(20000)`) — žiadna kontrola formátu, appka dôveruje obsluhe (nie
  klientom mimo appky) na TEXT, nikdy nie na business polia (recipient/
  orderCode/dedup token), tie appka vždy prepočíta sama.
- **Playwright's `toContainText`/testing-library's `textContent` NEVIDIA
  hodnotu kontrolovaného `<textarea>`** (React nastavuje `.value` ako
  DOM vlastnosť, nie textový uzol) — e2e/unit testy tela náhľadu preto
  musia čítať `toHaveValue()`/`screen.getByTestId<HTMLTextAreaElement>
  (...).value`, nikdy `toContainText`/`textContent` na kontajneri, ktorý
  textarea obsahuje (`nedostupne.spec.ts`/`order-merge.spec.ts`, issue
  277 — pôvodné testy kontrolovali `dangerouslySetInnerHTML` div a
  ticho by prestali overovať čokoľvek po prechode na textarea).
- **issue 347: `resolve-products.ts`'s `resolveReplacementProducts`
  spätne dohľadá majiteľov ručne vložený odkaz (`nedostupne_
  replacement_link.url`, issue 238 — appka k nemu NEPOZNÁ názov/kód)
  proti `shop_product_url`+`variants`, aby e-mailová karta mala NÁZOV/
  OBRÁZOK/CENU namiesto holej adresy.** Zámerne NEROZŠIRUje
  `nedostupne_replacement_link` o vlastné stĺpce (majiteľ by ich musel
  zadávať ručne) — katalóg tieto dáta UŽ MÁ pre každý náš produkt,
  spätné dohľadanie v momente stavby e-mailu je jednoduchšie a netrpí
  zastaraním (cena sa mení, odkaz sa vkladá raz). Zhoda: PRESNÁ url
  najprv, inak zhoda podľa CESTY bez `?variantId=` (majiteľ zvyčajne
  vkladá bázovú adresu, feed nesie s `?variantId=`); bez zhody sa
  správanie NEMENÍ oproti pred-347 stavu (`label = url`, žiadny
  obrázok/cena) — nikdy sa nič nefabrikuje, rovnaká disciplína ako
  vyššie ("nikdy nevyrábať adresu odhadom"). Volaná z JEDNÉHO miesta
  spoločného pre náhľad aj odoslanie (`send.ts`'s `buildEmailForType`)
  A zo samostatnej generickej šablónovej `previewContext` (`mail-
  templates/samples.ts`) — obe cesty musia ukázať TÚ ISTÚ kartu, inak
  by editor šablóny klamal o tom, čo appka naozaj pošle.
- **issue 344: riadok je "vybavený" keď `order.nedostupneSent ||
  order.alternativaSent` — buď typ e-mailu stačí, appka nikdy nevynucuje
  oba.** Šéf pôvodne pýtal "červené" pre vizuálne odlíšenie vybavených
  riadkov, ale červená v appke inde znamená CHYBU (`--fs-danger`, BCC/mail
  varovania na tej istej obrazovke) — použitý `--fs-success`/
  `--fs-success-bg` namiesto toho (zdôvodnené priamo na tikete), rovnaký
  "hotovo" jazyk ako `.ord-state-btn.active` inde v appke. Implementácia
  (CSS technika `box-shadow: inset`, nie `border`) je popísaná v
  `.claude/rules/frontend-design.md`. Keď šéf inde v appke znova povie
  konkrétnu farbu ("červené"/"zelené"), over najprv, či tá farba už v
  appke nemá iný, kolidujúci význam, než ju rovno použiješ — a zdôvodnenie
  zapíš na ticket, nech to vie posúdiť.
- **issue 529: 📦 preklik z „Nedostupné tovary" do „Na objednanie" je CELÁ
  navigácia stránky (`<a href="?tab=orders&highlight=<encodeURIComponent
  (variantCode)>">`), nie in-SPA prepnutie tabu** — `App.tsx` číta `?tab`
  LEN pri mounte a `NedostupneSection` nemá `selectTab` (len `role`/
  `onSessionExpired`), takže rovnaký vzor ako `FloorOrderRow`'s
  `?tab=floor-orders`. `OrdersSection` prečíta `highlight` z URL RAZ pri
  mounte a JEDNORAZOVÝM branch-and-return efektom riadok odkryje +
  naskroluje + zvýrazní (`order-row--highlight` + `data-order-highlight`,
  CSS 3s jantárová `forwards` animácia). **Efekt musí byť STRÁŽENÝ hore
  `if (highlightScrolledRef.current) return;`** — bez toho by počas ~4 s
  zhášacieho okna VRÁTIL manuálny klik používateľa na chip / znovu-zapnutie
  „skryť vybavené" (code review nález). Odkrytie: (1) chip filter →
  `selectSupplier(cieľ)` keď je vybraný INÝ dodávateľ; (2) „skryť vybavené"
  → `setHideResolved(false)` RAW setterom (NEpersistuje preferenciu — perzistuje
  len `toggleHideResolved`), lebo nedostupný riadok je `isLineResolved`
  (state !== "objednane"). 📦 je štvorcové tlačidlo ZDIEĽAJÚCE
  `.customer-contact-btn` štýl (na `<a>` + `text-decoration:none`), NEgatované
  (len navigácia); odkrývacie vetvy overuje UNIT test (e2e beží s čerstvým
  úložiskom = žiadny chip/hideResolved).
- **issue 529: poznámka na objednávkovom riadku sa zapíše ako poznámka
  objednávky do eshopu cez EXISTUJÚCU cestu `updateOrderComment` →
  `PUT /api/orders/:id/comment` → `order.comment` → Shoptet writeback worker
  (`.claude/rules/shoptet-writeback.md`), NIKDY nový mechanizmus** — tá istá
  cesta ako stĺpec POZNÁMKY v „Na objednanie". `NedostupneOrderRow` preto
  nesie `orderId` + `comment` (queries.ts + zod schéma). Draft je per-riadok
  (`${variantCode}|${orderCode}`, vzor `linkDrafts`), po uložení sa zahodí
  draft objednávky VO VŠETKÝCH skupinách (kľúč `|<orderCode>` — tá istá
  objednávka môže čakať na dva nedostupné varianty, inak zastaraný draft
  maskuje čerstvú hodnotu). Uloženie NEZMENENEJ hodnoty je zablokované
  (žiadny no-op PUT + zbytočné re-spustenie workera). Gated `canControl`
  (admin/manazer, parita s `requireRole` na trase). Vykreslenie vyčlenené do
  `NedostupneOrderNote.tsx` (eslint max-lines) — reuse `.ord-comment-input`.
- **issue 531: checkbox „vyriešené" pri karte produktu — nová tabuľka
  `nedostupne_resolved` kľúčovaná `variant_code` (PLAIN text, BEZ FK, ale s
  UNIQUE indexom — na rozdiel od `nedostupne_replacement_link`, lebo je to
  boolean per variant), PRÍTOMNOSŤ riadku = vyriešené.** Toggle je idempotentný
  v OBOCH smeroch (`setVariantResolved`, `resolved.ts`: `INSERT ... ON CONFLICT
  DO NOTHING` / `DELETE`), preto ŽIADNY advisory zámok (na rozdiel od
  `nedostupne_state`'s `NEDOSTUPNE_SEND_LOCK_KEY` — tam zámok chráni pred
  dvojitým ODOSLANÍM e-mailu; tu je to len boolean, last-write-wins je OK).
  `GET /api/nedostupne` pridáva `resolved: boolean` do skupiny (`loadResolvedVariants`
  → `Set`, vzor `loadSentNedostupne`). Zápis `PUT /api/nedostupne/resolved`
  `{variantCode, resolved}` — IDEMPOTENTNÉ nastavenie želaného stavu (nie
  POST/DELETE dvojica ako odkazy náhrad), gated `requireRole("admin","manazer")`.
  „Nič ďalšie sa nestane, len sa to označí" — žiadny e-mail, žiadne filtrovanie/
  skrytie karty. Frontend: checkbox v `.nedostupne-group-header` ZA 📦, vizuál
  ako „Objednané" (`.nedostupne-group-header input[type="checkbox"]` — parent-
  scoped, špecificita (0,0,2,1) prebíja globálny `input{width:100%}` reset,
  issue 403 pasca); viditeľný VŠETKÝM, `disabled` pre non-`canControl`. Toggle
  je OPTIMISTICKÝ (lokálna zmena hneď + revert pri chybe, `useNedostupneResolved.ts`
  hook — vyčlenené kvôli eslint `max-lines`) — ŽIADNY plný reload zoznamu,
  lebo označenie nemení triedenie (`placedAt`) ani skladbu kariet. Nová root
  tabuľka → doplnená do OBOCH TRUNCATE zoznamov (`tests/helpers/db.ts` +
  `scripts/e2e-setup.ts`, `truncate-list-completeness.test.ts` to vynucuje).
  Migrácia 0063 je plain CREATE TABLE + index (žiadny enum → žiadny #399 risk).
- **issue 535: optimistický toggle „vyriešené", ktorého zoznam refetchujú INÉ
  akcie (`saveNote`/`addLink`/`removeLink`/`confirmSend` volajú `load()`),
  potrebuje aby `load()` REKONCILIOVAL nevyrovnané optimistické zmeny —
  `useStaleResponseGuard` (PR #536) rieši len load-vs-load, NIE
  load-vs-optimistický-zápis.** `useNedostupneResolved` vedie
  `pendingResolvedRef: Map<variantCode, {desired, committed}>` (zapíše sa pri
  toggle, zmaže pri chybe PUT + revert) a vystaví STABILNÝ `reconcileResolved(list)`
  (`useCallback([])` nad refom — inak by refiroval `useEffect(load)`), ktorý
  `load().then` zavolá PRED `setList`. Rekonciliácia je self-cleaning s
  OHRANIČENOU životnosťou (code review nález, inak by nezhodný záznam maskoval
  súbežnú CUDZIU zmenu donekonečna): server sa zhoduje → zmaž; nezhoduje +
  necommitnutý → drž optimistickú hodnotu; nezhoduje + commitnutý (PUT `.then`
  označí `committed`, len ak ho neprebil novší toggle) → ochráň JEDEN zastaraný
  in-flight load a zmaž. **Toto je TRETÍ tvar „latest ref"/stale-response triedy
  (`.claude/rules/frontend-design.md` issue 251/523: load-vs-load) — pri KAŽDOM
  ďalšom optimistickom zápise, ktorého zoznam refetchuje iná akcia, over túto os,
  nie len guard.** Pridružený nález: `setResolvedBusy("")` vo `.finally()` musí
  byť FUNKČNÝ clear (`(cur) => cur === variantCode ? "" : cur`) — jediný skalár,
  súbežný toggle iného variantu ho inak vyčistí mid-PUT.
