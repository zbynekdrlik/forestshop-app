# Inventár starej appky `parovanie_produktov` — čo musí nová appka vedieť

Zistené 2026-07-29 prieskumom repa `~/devel/forestshop/parovanie_produktov`
(Flask, `webreview/app.py` ~10 700 riadkov, žiadna SQL databáza — všetko JSON
súbory v `data/out/`, beží ako 2× `systemd --user` na dev1 za Cloudflare
tunelom na 3 doménach).

Určené ako podklad pre prepis do novej appky (`forestshop-app`, fázy F2–F6).

## Obrazovky (to, čo človek reálne používa)

1. **Na objednanie** — hlavný denný nástroj manažéra. Otvorené objednávky
   („Vybavuje sa") zoskupené podľa dodávateľa, odkaz na dodávateľský produkt,
   príznaky objednané / čaká sa / skladom / nedostupné, doplnenie chýbajúceho
   dodávateľa, spárovanie URL priamo z riadku, kopírovanie objednávky, komentár
   k objednávke, rozdelenie na veľkosti, konfigurovateľné stavy objednávok.
2. **Nedostupné tovary** — označenie „dodávateľ nemá" + odoslanie jedného z
   dvoch e-mailov zákazníkovi (nedostupné / nedostupné + alternatíva), vždy s
   náhľadom pred odoslaním.
3. **Kontrola párovania (review)** — vizuálne porovnanie nášho produktu s
   navrhnutým dodávateľským kandidátom, ✓/✗ alebo ručný výber inej URL.
4. **Hľadať / opraviť** — fulltext cez celý katalóg (názov, dodávateľ, kódy,
   EAN, kategória), oprava párovania mimo review setu.
5. **Poznámky** — voľné poznámky manažéra (nahradilo Discord vlákno).
6. **Poľovnícke výstavy** — stavový stroj registrácií na stánky (Nová →
   otázka poslaná → čaká na rozhodnutie → prihláška poslaná → potvrdené).
7. **Vývoj** — zoznam GitHub úloh priamo vo webe (šéf nemá GitHub účet) +
   „žiarovka" na zápis nápadu, ktorý založí úlohu, vrátane priority.
8. **Prihlásenie a používatelia** — login, správa účtov, zabudnuté heslo cez
   e-mail.
9. **Párovanie produktov (mimo webu, CLI)** — vyhľadá produkt u dodávateľa a
   AI overí zhodu; 30+ dodávateľov a 8 generických enginov (shoptet,
   prestashop, woocommerce, opencart, magento, jigoshop, kabernet, flox).

## Automatizácie (16, dnes jeden Python thread vo Flasku, default VYPNUTÉ)

| Kedy | Čo robí |
|---|---|
| každú hodinu | stiahne objednávky (90 dní) + celý katalóg zo Shoptetu |
| každú hodinu | pošle do Shoptetu jeden import zo spoločnej fronty zmien |
| denne 3:30 | GRUBE kódy pre jednotlivé veľkosti → eshop |
| denne 3:45 | odkazy rozdelené podľa veľkostí → eshop |
| denne 4:30 | kontrola vlastných fotiek (mŕtve sa skryjú) |
| denne 5:00 | scraping dostupnosti a cien u dodávateľov (platený AI fallback) |
| denne 6:00 | výstavy: rozposlanie úvodných otázok organizátorom |
| denne 6:00 | vypredané u nás, ale dodávateľ má znovu → reštok **(reálne nikdy nebežalo, #300)** |
| denne 6:15 | riziko výpadku: naše „Skladom", ktoré dodávateľ už nemá (len report) |
| denne 6:45 | máme reálny sklad > 0, ale zobrazuje sa „Vypredané" → oprava |
| denne 8:00 | pripomienky objednávok starších než 4 dni (AI posúdi poznámku, potom e-mail zákazníkovi, max 1×) |
| denne 9:00 | nevyzdvihnuté zásielky na Pošte SK, až 4 eskalačné e-maily (0/+3/+3/+7 dní) |
| denne 9:00 / 9:30 | výstavy: kontrola e-mailových odpovedí na otázku / na prihlášku |
| denne 21:00 | nové napárovania a priradení dodávatelia → eshop |

Zdieľaná fronta `pending_shoptet.json` má 5 producentov a jediného
spotrebiteľa (hodinový upload) s overením zápisu spätným čítaním.

## Čo NEkopírovať naslepo

- **Reštok „Vypredané → Skladom" reálne nikde nebeží** (#300) — v eshope tak
  zostávajú vypredané produkty, ktoré dodávateľ dávno naskladnil.
- `textProperty10` sa cez CSV import Shoptetu nastaviť **nedá** — pôvodný
  predpoklad v README bol omyl, nahradené `internalNote`.
- PWA inštalácia appky ako ikony už nefunguje (#251).
- Niektorí dodávatelia sa napárovať nedajú vôbec (ORBIS, HABO OBUV, Hunting &
  Fishing — len B2B login; LUKO a ROY — výroba na zákazku). KOZAP + MALFINI
  majú parser, ale hľadanie potrebuje iný spôsob dotazu (#79). DYNAX nikdy
  neoverený naživo (#76).
- Dvojosový GRUBE komplet (bunda + nohavice) je natrvalo len odkaz.
- Cena od českého dodávateľa sa číta ako EUR namiesto CZK (#248).
- Trieda chýb „tichá smrť automatizácie" — zamrznuté cesty úložísk zmazali
  2831 rozhodnutí (#261), duplicitná inštancia bežala 4 dni popri ostrej
  (#262), poškodený dedup store sa ticho prepísal na prázdny (#225), Pošta 5
  dní nevidela zásielku a hlásila zelené OK (#282). Toto je dôvod, prečo má
  nová appka jeden plánovač v databáze s auditom behov, nie vlákna a JSON
  súbory.

## Stav novej appky k 2026-07-29

Hotové: celé F0 (prihlásenie, role, audit, nasadenie, verzia na stránke) a
celé F1 (katalóg zo Shoptetu — import, snapshoty, varianty, ceny, dostupnosť).
Z F2–F6 nie je v kóde nič: chýba plánovač, objednávky, párovanie, maily aj
správa používateľov. Tabuľky dnes: `users`, `sessions`, `audit_events`,
`catalog_snapshot`, `product`, `variant`, `ingest_issue`.
