# Forestshop — návrh systému (prerábka párovania na firemný systém)

Dátum: 2026-07-29
Stav: schválené jadro (rozsah, prechod, jazyk, prevádzka), čaká sa na revíziu celého dokumentu

## 1. Prečo sa to prerába

Dnešný nástroj `parovanie-produktov` (repo `zbynekdrlik/parovanie-produktov`) je za ~5 týždňov
narástol na 999 commitov a 156 ticketov (50 otvorených). Vzniká viac chýb, než pribúda funkcií.

Namerané na repe k 2026-07-28:

| Ukazovateľ | Hodnota |
|---|---|
| `webreview/app.py` | 10 081 riadkov |
| `webreview/static/app.js` | 5 862 riadkov |
| API endpointy v jednom súbore | 72 |
| Úložiská dát (JSON súbory v `data/out`) | 32 |
| Zálohy na tom istom stroji ako dáta | 4,2 GB |
| Plánovače bežiace súbežne | 2 (vlastný thread-runner + n8n) |

Rozdelenie ticketov podľa príčiny (koľkých ticketov sa téma dotýka; jeden ticket môže spadať
do viacerých):

| Príčina | Tickety |
|---|---|
| Súborové úložiská / cache (poškodenie, prepis, zmrazená cesta, strata histórie) | 62 |
| Súbeh, zámky, clobber guardy | 29 |
| Export/import CSV zo Shoptetu (prázdny export, timeout, pamäť, fail-open brány) | 34 |
| Tiché zlyhania (beh umrie, nikto sa nedozvie) | 27 |
| Model produkt vs. variant/veľkosť (`internalNote` je per-produkt) | 30 |
| Dva plánovače (n8n vs. appka) | 21 |
| Kódovanie cp1250 / UTF-8 / BOM / newline | 9 |

### Štyri systémové príčiny

1. **JSON súbory namiesto databázy.** Kód si musel vyrobiť vlastnú náhradu transakcií:
   `_StorePath`, `StoreWipeRefused`, karanténa poškodených súborov, medziprocesové `fcntl`
   zámky, „read receipts". Napriek tomu sa prepísalo 2 831 rozhodnutí manažéra (#261).
2. **Chýba doménový model.** Vzťah produkt ↔ variant ↔ kód ↔ párovanie nie je nikde
   definovaný, preto „dve veľkosti jedného produktu sa nikdy nepotvrdia a posielajú sa
   donekonečna" (#273, #304) nie je chyba, ale dôsledok.
3. **Vedľajšie účinky bez fronty.** Maily zákazníkom a zápisy do Shoptetu idú priamo, bez
   idempotencie a bez auditu → duplicitné maily (#225), „nahraté len pri jednom" (#304).
4. **Nulová pozorovateľnosť.** Automatizácia môže byť 5 dní zamrznutá (#302) alebo nikdy
   nezapnutá (#300) a aplikácia svieti zeleno.

Oprava 50 ticketov tieto príčiny neodstráni. Cieľom prerábky je, aby celé tieto triedy chýb
**neboli možné**.

## 2. Rozhodnutia (schválené používateľom 2026-07-29)

| Rozhodnutie | Voľba | Dôvod |
|---|---|---|
| Rozsah | Firemný systém, nie len nástroj | Zodpovedá vízii #103 (modulárny firemný dashboard); jadro sa nebude prepisovať pri každej novej oblasti |
| Prechod | Po moduloch, súbežne so starou appkou | Firma na appke denne pracuje; nulový výpadok |
| Jazyk | TypeScript v prísnom režime | Jeden jazyk pre server, web aj testy; najspoľahlivejšie písanie AI pri zachovaní kontroly |
| Databáza | PostgreSQL | Transakcie, obmedzenia, migrácie, fronta úloh na jednom mieste |
| Prevádzka | dev2 (zatiaľ), všetko v Dockeri | Presun na VPS neskôr = zmena konfigurácie, nie prepis |

Zvážené a zamietnuté: Rust jadro (2–3× pomalší vývoj, druhý jazyk kvôli webu), striktný
Python (prísnosť dobrovoľná — riziko zopakovania dneška), Odoo (nadstavba nad Shoptetom by
bojovala s jeho modelom), mikroslužby / Kubernetes / Kafka / Redis / serverless / NoSQL
(nové režimy zlyhania bez prínosu pre systém s tromi používateľmi na jednom stroji).

Odložené na neskôr, nie zabudnuté: *durable execution* (Temporal / Restate / DBOS) —
viackrokové procesy prežijú pád uprostred. Zatiaľ sa ten istý efekt dosiahne idempotentnými
krokmi a stavom v databáze; doplniteľné bez prepisovania jadra.

## 3. Tvar systému

Jeden nasaditeľný celok rozdelený na moduly (modulárny monolit). Na dev2 bežia štyri
kontajnery: `app` (API + web), `worker` (fronta a automatizácie), `postgres`,
`cloudflared` (verejná linka bez otvoreného portu).

| Modul | Zodpovednosť |
|---|---|
| `catalog` | katalóg zo Shoptetu — import, snapshoty, kódy, ceny, dostupnosť |
| `pairing` | párovanie produktov na stránky dodávateľov, revízia, split podľa veľkostí |
| `suppliers` | adaptéry dodávateľov (hľadanie, sklad, cena) |
| `orders` | Na objednanie, stavy riadkov, kopírovanie objednávky, tržby |
| `shipping` | Pošta, nevyzdvihnuté zásielky, eskalácia |
| `messaging` | maily zákazníkom (pripomienky, nedostupný tovar), náhľady |
| `automations` | plánovanie, behy, alarmy, zdravie zdrojov |
| `admin` | používatelia, práva, premenovanie záložiek, nastavenia |

Dve vynútené pravidlá:

1. **Modul nesiaha do cudzích tabuliek** — len cez verejné funkcie iného modulu.
2. **Súbor má strop ~400 riadkov** (lint). Dnešných 10 081 riadkov v jednom súbore je
   dôvod, prečo každá oprava rodí ďalšie chyby.

## 4. Databáza a doménový model

Jedna pravda v PostgreSQL. Žiadne JSON súbory ako úložisko.

| Tabuľka | Načo je |
|---|---|
| `catalog_snapshot` | každý stiahnutý export ako nemenný záznam (hash, počet riadkov, prítomné stĺpce, verdikt) |
| `product` / `variant` | produkt a jeho veľkosti; **kód je identita variantu**, nie produktu |
| `pairing` | variant → URL dodávateľa, stav, kto a kedy potvrdil |
| `supplier` | dodávateľ, jeho adaptér, mena, veľkoobchodná stránka |
| `order` / `order_line` | objednávky zákazníkov a ich riadky |
| `order_line_state` | stav riadku ako automat (objednané / čaká / skladom / nedostupné) |
| `outbox_message` | všetko odchádzajúce (import do Shoptetu, mail) + kľúč idempotencie |
| `automation_run` | každý beh: kedy, z akého snapshotu, počty, výsledok |
| `audit_event` | kto, čo, kedy — len pribúda, nikdy sa neprepisuje |

Sumy sa ukladajú vždy s menou (bez meny sa suma nedá zapísať).

### Ktoré triedy dnešných chýb tým zanikajú

| Dnešná chyba | Prečo v novom systéme nie je možná |
|---|---|
| Prepis 2 831 rozhodnutí (#261), poškodené úložisko (#225, #229, #230), prázdna cache (#286) | Transakcie — zápis prejde celý alebo vôbec |
| Dve veľkosti sa nikdy nepotvrdia (#273, #304) | Párovanie viazané na variant; obmedzenie „jedno pole na produkt" je v schéme |
| Prázdny/skrátený export prepíše dobré dáta (#277, #281, #286) | Snapshot sa overí; neplatný sa odmietne, beží sa ďalej z posledného platného |
| Duplicitné maily (#225), „nahraté len pri jednom" (#304) | Outbox s kľúčom idempotencie |
| Česká cena čítaná ako eurá (#248) | Suma bez meny neexistuje |
| Vylučujúce sa stavy, osirelé príznaky (#211, #212, #239) | Stavový automat + obmedzenia v databáze |
| Chýbajúci audit (#219), strata histórie (#229, #230) | `audit_event` a `automation_run` sú súčasť jadra |

Zálohy: nočný `pg_dump` s kópiou mimo dev2 (na dev1), mesačná skúška obnovy.

## 5. Automatizácie a odchádzajúce zápisy

Jeden plánovač — fronta úloh v Postgrese (Graphile Worker), definície behov v kóde. n8n sa
ruší; dnešné rozdvojenie je príčina, prečo reštok nebeží nikde (#300).

- Každý beh zapíše: čas, snapshot, vstupné a výstupné počty, výsledok, chybu.
- **Každý zdroj dát má maximálny povolený vek.** Starší zdroj = beh je degradovaný a pingne
  Discord (#302, #285, #286).
- Nová automatizácia sa nasadzuje vypnutá; zapnutie je zaznamenaná akcia (pravidlo z #93).
- Jeden beh naraz na automatizáciu, opakovanie s odstupom, tvrdý časový strop.
- Parametre (počet dní, MAX mailov, kadencia) sú v databáze, nie v kóde (#221).

Outbox: nič nejde von priamo. Každá správa má typ, kľúč idempotencie, stav a náhľad pred
odoslaním. Import do Shoptetu ide po častiach, takže čiastočný úspech je normálny stav, nie
zlyhanie na 120-sekundovom limite (#156, #158).

## 6. Používatelia a bezpečnosť

Role: **admin**, **manažér**, **šéf**, **čítanie**. Prihlásenie e-mailom a heslom (argon2),
relácie v databáze, reset cez mail, miesto na druhý faktor.

Každá zmena nesie autora — ručný zásah sa už nezobrazí ako verdikt AI (#227). Prístupové
údaje (Shoptet, Pošta, SMTP, Discord) sú mimo repa; v databáze je len odkaz na ne.

## 7. Testovanie a nasadenie

- Jednotkové a integračné testy proti dočasnému Postgresu v CI (nie mocky).
- Parsery dodávateľov proti preneseným 44 uloženým HTML fixtúram — výsledok sa musí zhodovať
  s dnešným.
- Playwright na reálne toky manažéra, nula chýb v konzole prehliadača.
- Čas je vstupom, nie globálom — ruší časované bomby v testoch (#201).
- Brány v CI: typová kontrola, lint (zákaz `any`, strop dĺžky súboru), testy, migrácie,
  verzia vyššia než na `main`.
- Nasadenie z CI cez Docker Compose na dev2, verzia viditeľná v pätičke a overená po
  nasadení čítaním z živej stránky.

## 8. Plán fáz

| Fáza | Obsah | Čo sa vypína v starej appke |
|---|---|---|
| F0 Základ | repo, databáza, CI, nasadenie, prihlásenie, dashboard s verziou | — |
| F1 Katalóg | import zo Shoptetu, snapshoty, varianty, ceny, dostupnosť | — |
| F2 Automatizácie | 6 automatizácií + n8n workflows na nový runner, alarmy, audit | n8n |
| F3 Na objednanie | stavy riadkov, kopírovanie objednávky, tržby (#267, #268) | záložka Na objednanie |
| F4 Párovanie | revízia, dodávatelia, split veľkostí, GRUBE | záložky párovania |
| F5 Pošta a maily | pripomienky, nedostupné tovary, eskalácia cez outbox | záložky pošty |
| F6 Vývoj a správa | požiadavky šéfa (#244–247), premenovanie, používatelia | stará appka celá |

V každej fáze sa prejdú príslušné otvorené tickety starého repa: buď ich návrh rieši (zavrú
sa s odkazom na túto fázu), alebo sa prenesú ako požiadavka do nového repa. Nič sa nezahadzuje.

## 9. Riziká a ako sa znižujú

| Riziko | Opatrenie |
|---|---|
| Prepis býva chvíľu horší než pôvodný systém | Prechod po moduloch; stará časť sa vypína až keď nová tú oblasť vie |
| Dva systémy súbežne ~2 mesiace | Vedomá daň. Hranica je ostrá: prevzatú oblasť vlastní nový systém a v starej appke sa vypne; neprevzaté oblasti bežia ďalej na svojich súboroch. Žiadna oblasť nemá dvoch vlastníkov naraz |
| Strata poznania z 156 ticketov a 44 fixtúr | Samostatná úloha v každej fáze — pravidlá a testy, nie iba kód |
| Typy v TypeScripte miznú za behu | Validácia schémou na každej hranici (Shoptet CSV, HTML dodávateľov, Pošta API, maily) |
| Migrácia dát manažéra (rozhodnutia, párovania, príznaky) | Jednorazový import s overením počtov a náhodnou vzorkou pred vypnutím starej časti |
