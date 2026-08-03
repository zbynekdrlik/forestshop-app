# Automatické zapínanie produktov — návrh

**Cieľ:** Keď dodávateľ dostane tovar naspäť na sklad, náš vypredaný produkt sa
sám prepne na „Skladom" — bez toho, aby to niekto ručne sledoval.

**Architektúra:** Dve nezávislé časti, prepojené jednou tabuľkou. Scraper
(Systém) každú noc zistí dostupnosť u dodávateľov a zapíše ju do
`supplier_stock`. Automatizácia (Automatizácie) z nej po scrape vyberie naše
vypredané produkty, ktoré dodávateľ potvrdene má, a prepne ich v Shoptete
existujúcou spätno-zápisovou cestou. Scraper nikdy nič nezapisuje do Shoptetu;
automatizácia nikdy nechodí na internet.

**Technológie:** Hono + Drizzle + PostgreSQL 18, React 19 + Vite, Playwright
(už existujúci Shoptet spätný zápis), `undici` fetch (súčasť Node 24).

## Rozhodnutia majiteľa (3. 8. 2026)

Tieto tri rozhodnutia padli pri návrhu a sú záväzné:

1. **Prepínanie beží samo každú noc** — nie na kliknutie, nie nasucho. V appke
   je vidieť, čo prepla.
2. **Žiadna AI.** Stránka, ktorú sa nepodarí prečítať bežným spôsobom, sa označí
   ako „neviem" a taký produkt sa nikdy neprepne. Nečitateľné stránky sa
   majiteľovi **ukazujú v zozname**, aby sa dalo rozhodnúť, či sa oplatí dorobiť
   pre ne čítanie ručne.
3. **Strop 50 prepnutí za jeden beh.** Zvyšok počká na ďalšiu noc; appka napíše,
   koľko čaká. Strop je konfigurovateľný a dá sa kedykoľvek zdvihnúť.

## Meranie na reálnych dátach (nie odhad)

Zmerané na produkčnom Shoptet exporte (14 014 riadkov, read-only):

| Veličina | Hodnota |
|---|---|
| Riadkov s dodávateľskou linkou | 1 210 |
| Unikátnych dodávateľských liniek | 238 |
| Domén dodávateľov | 4 (`huntingshop.eu` 969, `wetland.sk` 233, `trigona.sk` 6, `dogtrace.com` 2) |
| Vypredané + `visible` + má linku | 767 |
| `detailOnly` riadkov spolu | 5 276 |
| **`detailOnly`, ktoré naša derivácia dnes hlási ako `out_of_stock`** | **526 (z toho 38 s linkou)** |

Posledný riadok je dôvod, prečo časť B začína opravou katalógu — bez nej by
automatizácia zapla produkty, ktoré majiteľ vedome vypol.

## Predpoklad — viditeľnosť produktu sa musí ukladať

`productVisibility` sa dnes zo Shoptet exportu prečíta, použije v
`deriveVariantState` a **zahodí** — v databáze nie je. `detailOnly` pritom nie
je v `HIDDEN_VISIBILITIES`, takže vypredaný `detailOnly` produkt je dnes v
databáze nerozoznateľný od bežného vypredaného.

Oprava: nový stĺpec `product.visibility` (text, plnený pri katalógovom importe
rovnakou first-wins cestou ako `supplier`/`internal_note`). Derivácia stavu sa
**nemení** — `detailOnly` naďalej nie je „discontinued", lebo produkt sa dá
kúpiť cez priamy odkaz. Mení sa len to, že automatizácia má podľa čoho vylúčiť.

## Časť A — Scraper dostupnosti u dodávateľa

### Dáta

Nová tabuľka `supplier_stock`, jeden riadok na unikátnu linku:

| Stĺpec | Význam |
|---|---|
| `link` (unique) | dodávateľská URL, kľúč |
| `host` | doména (pre slušnosť a pre štatistiku) |
| `availability` | `available` / `unavailable` / `unknown` |
| `availability_text` | pôvodný text zo stránky, nezmenený |
| `price` | cena u dodávateľa, ak sa dala prečítať |
| `source` | `json_ld` / `meta` / `text` — čím sa to podarilo prečítať |
| `ok` | či kontrola prebehla bez chyby |
| `error`, `http_status` | dôkaz pri zlyhaní |
| `checked_at` | čas poslednej úspešnej kontroly |

### Čítanie stránky — tri úrovne, žiadne hádanie

1. **JSON-LD `Product`** (`schema.org` `offers.availability`) — strojový údaj,
   ktorý dávajú Shoptet, WooCommerce aj PrestaShop. Najspoľahlivejší.
2. **`og:` / `product:` meta značky** — keď JSON-LD chýba.
3. **Kľúčové slová v texte** („Skladom", „Vypredané", „Není skladem", …) — len
   pre domény, kde je to overené na uloženej vzorke stránky.

Čokoľvek, čo neprejde ani jednou úrovňou → `unknown`. `unknown` **nikdy**
neprepne produkt.

### Beh

- Naplánovaný **denne v noci** (scheduler F2, `job_run` záznam ako ostatné joby)
  + tlačidlo „Spustiť teraz".
- Vlastný advisory zámok `787_878_007` (`SUPPLIER_STOCK_RUN_LOCK_KEY`) — job má
  manuálny trigger na tú istú prácu, takže rovnaký vzor ako
  `postaUncollectedJob`.
- **Slušnosť:** sériovo, minimálna pauza medzi požiadavkami na tú istú doménu,
  vlastný `User-Agent` s kontaktom, strop na veľkosť odpovede, časový limit na
  požiadavku.
- **Preskočenie čerstvých:** linka s úspešnou kontrolou mladšou než 20 h sa
  znovu nesťahuje.
- Zlyhanie jednej linky nesmie zhodiť celý beh — zapíše sa `ok = false` a ide sa
  ďalej.

### Obrazovka (Systém → Dodávateľský sklad)

- Posledný beh: kedy, ako dlho trval, koľko liniek skontroloval.
- Počty: skladom / vypredané / neviem / chyba.
- Tabuľka liniek s dostupnosťou, cenou, časom kontroly a odkazom.
- **Samostatná karta „Stránky, ktoré neviem prečítať"** — zoznam `unknown` a
  chybových liniek zoskupený podľa domény, aby bolo vidieť, pre ktorého
  dodávateľa sa oplatí dorobiť čítanie.

## Časť B — Automatizácia Vypredané → Skladom

### Výber kandidátov

Prepne sa variant, ktorý spĺňa **všetko naraz**:

- náš stav je `out_of_stock`,
- `product.visibility` je presne `visible`,
- produkt má dodávateľskú linku,
- `supplier_stock` pre tú linku má `ok = true` **a** `availability = available`,
- `checked_at` nie je staršie než **48 h**.

**Nikdy sa neprepne:** `detailOnly`, `hidden`, `blocked`, `cashDeskOnly`,
`blockUnregistered`, čokoľvek s „Predaj výrobku skončil", ani variant, ktorý už
je `sellable` (z toho plynie idempotencia — po prepnutí a ďalšom katalógovom
importe už kandidátom nie je).

Každý `code` sa v jednom behu objaví najviac raz — Shoptet zruší celý import pri
duplicitnom kóde.

### Zápis do Shoptetu

Ide **existujúcou** cestou (`buildWritebackCsv` + Playwright import na
`/admin/import-produktov/`, `.claude/rules/shoptet-writeback.md`). Riadok nesie:

| Stĺpec | Hodnota |
|---|---|
| `code`, `pairCode` | identita variantu |
| `visibility` | `visible` |
| `availabilityInStock` | `Skladom` |
| `availabilityOutOfStock` | `Skladom` |
| `stock` | kladné číslo |

**Obidve `availability` polia sa musia nastaviť naraz.** Shoptet zobrazuje
`availabilityOutOfStock` v momente, keď sklad klesne na nulu — zápis len do
`availabilityInStock` nechá po dopredaní znovu naskočiť staré „Vypredané".
(Overené v ostrej prevádzke starej appky 14. 7. 2026.)

### Beh a poistky

- Naplánovaný **po** scrape, tou istou nočnou kadenciou; vlastný advisory zámok
  `787_878_008` (`RESTOCK_RUN_LOCK_KEY`).
- **Strop 50 prepnutí za beh** (konfigurovateľné). Pri prekročení sa prepne
  prvých 50, zvyšok ostáva kandidátom na ďalšiu noc a appka to napíše.
- Prepínač `Beží / Vypnuté` ako ostatné automatizácie (`settings`), vypnutá
  automatizácia nezapisuje nič.
- Každé prepnutie sa zapíše do `restock_event` (kód, názov, dodávateľ, linka,
  dostupnostný text dodávateľa, čas) — to je dôkaz „že to funguje".

### Obrazovka (Automatizácie → Vypredané → Skladom)

- Prepínač Beží/Vypnuté, posledný beh, počet prepnutých a počet čakajúcich na
  strop.
- Tabuľka prepnutých produktov: dátum, kód, názov, dodávateľ, odkaz na
  dodávateľa, čo dodávateľ hlásil.

## Bezpečnostné pravidlá

- Prihlasovacie údaje do Shoptet administrácie ostávajú **výhradne** v
  premenných prostredia na dev2 (`.claude/rules/sensitive-values.md`).
- Žiadny test nesmie siahnuť na skutočnú stránku dodávateľa ani na skutočný
  Shoptet — čítanie stránok ide cez rozhranie, ktoré si testy nahradia vlastným,
  a vzorky stránok sú uložené ako fixtúry.
- Zápis do Shoptetu ide vždy cez `buildWritebackCsv` (ochrana proti CSV
  injection), nikdy vlastným skladaním stĺpcov.

## Testovanie

- Čisté funkcie (čítanie dostupnosti zo vzorky stránky, výber kandidátov) majú
  jednotkové testy nad uloženými vzorkami — bez siete.
- Integračné testy nad databázou: výber kandidátov vylúči `detailOnly`, zastarané
  potvrdenie, `unknown`, už predajný variant; strop drží.
- E2E test: obe obrazovky sa načítajú, ukážu posledný beh a tabuľku, konzola
  prehliadača je bez chýb.

## Čo NIE je v rozsahu

- AI čítanie stránok (majiteľ zamietol 3. 8. 2026).
- Automatické zapínanie z **nášho vlastného** fyzického skladu (stará appka to
  mala ako samostatnú vec) — nikto to nežiadal.
- Vypínanie produktov, keď dodávateľ vypredá. Tento návrh len zapína.
