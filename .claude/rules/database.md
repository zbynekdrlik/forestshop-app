---
paths:
  - "docker-compose.yml"
  - "docker-compose.prod.yml"
  - "apps/api/drizzle/**"
  - "apps/api/drizzle.config.ts"
  - "apps/api/src/db/**"
  - "apps/api/src/index.ts"
---

# Database / Docker

- **`postgres:18-alpine` zmenil default `PGDATA`** na
  `/var/lib/postgresql/<major>/docker` namiesto klasického
  `/var/lib/postgresql/data`. Named-volume mount priamo na
  `/var/lib/postgresql/data` preto crash-loopuje (image ho vyhodnotí ako
  "unused mount" a odmietne štart —
  `docker-library/postgres#1259`). Fix: obe compose súbory (dev aj prod)
  explicitne pinujú `PGDATA: /var/lib/postgresql/data` v `environment:` sekcii
  `postgres` služby. Ak niekedy vznikne ďalší compose súbor s Postgres 18+
  named volume, potrebuje ten istý pin, inak zopakuje presne tento pád.
- CI `integration`/`e2e` joby bežia Postgres bez volume mountu vôbec (services
  kontajner, efemérny) — tento problém sa tam nikdy neprejaví, len pri
  lokálnom/prod behu s perzistentným volume.
- **Migrácie bežia pri štarte aplikácie** (`apps/api/src/index.ts`), nie ako
  samostatný deploy krok — `deploy.yml` preto nemá vlastný migračný step,
  spolieha sa na to, že appka si to spraví sama pri boote kontajnera.
- **Drizzle-ov migrátor nedrží advisory lock.** Každá migrácia beží vo
  vlastnej transakcii (takže appka nikdy neobslúži polovične zmigrovanú
  schému), ale dve súčasne štartujúce inštancie by si mohli pretekať o rovnaké
  DDL. Netýka sa dnešného deploy flow (beží vždy presne jedna inštancia) —
  ak sa niekedy pridá druhá replika appky, toto sa musí doriešiť pred tým.
- **`drizzle-kit` 0.30.x nevie `db:generate`/`db:migrate`, keď jeden
  `src/db/schema*.ts` súbor cez `export * from "./other.js"` odkazuje na iný
  (napr. `schema.ts` re-exportuje `schema-catalog.ts`).** Jeho zabudovaný
  `esbuild-register` loader rieši `require()` čisto podľa Node-ovho klasického
  CJS resolvera — pri explicitnom `.js` (nutnom kvôli
  `verbatimModuleSyntax`/natívnemu ESM v `dist/`) nehľadá sesterský `.ts`
  súbor, takže padne na `MODULE_NOT_FOUND`, hoci `vitest`/`tsx` ten istý import
  bez problémov vyriešia. Fix: bump `drizzle-kit` na `^0.31.0` (vyriešené v
  0.31.10) — vymenil si interný TS loader a `.js → .ts` sesterský import
  vyrieši správne. Je to len devDependency (CLI, nie runtime `migrate()` v
  `index.ts`), takže bump nemení produkčné správanie; `drizzle-orm ^0.38.0`
  zostáva kompatibilné (interný `compatibilityVersion` check prejde). Ak
  pribudne ďalší `schema-*.ts` súbor s re-exportom, over `db:generate` hneď —
  ak `drizzle-kit` opäť klesol pod `^0.31.0`, toto je presne ten istý pád.
- **`drizzle-kit` (`^0.31.x`) je jeden release generation pred `drizzle-orm`
  (`^0.38.x`)** — review F1 Task 1 na to upozornil ako zvyškové riziko, nie
  ako aktuálnu chybu (`compatibilityVersion` check pri `db:generate` zatiaľ
  prechádza bez varovania). Kým sa obe knižnice nezarovnajú na rovnakú
  generáciu, každú vygenerovanú `.sql` migráciu si pred commitom prečítaj —
  neber jej obsah len na základe toho, že `db:generate` prebehlo bez chyby.
- **Funkcia, ktorá má bežať AJ na top-level `db`, AJ vnútri `db.transaction(async (tx) => ...)`,
  nesmie typovať svoj parameter ako `Database`** (`db/client.ts`'s
  `NodePgDatabase<schema> & {$client: Pool}`) — `tx` je `PgTransaction`,
  ktorý zdieľa spoločného predka (`PgDatabase`) a má rovnaký `.insert()`/
  `.select()`/`.update()`/`.delete()` tvar, ale CHÝBA mu `$client`, takže
  `tsc` (s `exactOptionalPropertyTypes: true`) odmietne `tx` ako argument
  typu `Database`. Fix: zúž parameter na `Pick<Database, "insert">` (alebo
  ktorákoľvek metóda skutočne potrebná) namiesto celého `Database` — to je
  presne to, čo `modules/audit/service.ts`'s `record()` robí (`AuditExecutor`
  typ), aby ho bolo možné volať `record(tx, ...)` vnútri transakcie
  (#10, `changePassword`). Rovnaký test pri KAŽDEJ ďalšej zdieľanej funkcii:
  potrebuje volajúci naozaj CELÝ `Database`, alebo len pár metód?
- **Nový `schema-<oblasť>.ts` súbor, ktorý potrebuje `users`/`sessions`/
  `audit_events`, si NESMIE po ne siahnuť cez `./schema.js` (barrel)** — `schema.ts`
  re-exportuje KAŽDÝ `schema-*.ts` súbor cez `export *`, takže import z barrelu
  vytvorí kruh (`schema.ts` → nový súbor → `schema.ts`). Preto sú `users`/
  `sessions`/`audit_events` od #44 vo vlastnom sibling súbore
  `schema-users.ts` (schema.ts je odvtedy ČISTÝ barrel, žiadne vlastné
  definície) — nový `schema-*.ts` importuje `users` odtiaľ priamo, presne ako
  `schema-orders.ts` importuje `variants` z `schema-catalog.ts`. Rovnaký test
  pri každom ďalšom novom `schema-*.ts`: potrebuje niečo z `users.ts`/inej
  sibling tabuľky? Import PRIAMO z toho súboru, nikdy cez `schema.js`.
- **CHECK, ktorý viaže STAV na DVA nullable stĺpce naraz, sa NEDÁ vyjadriť
  bare rovnosťou booleovských výrazov** (vzor `catalog_snapshot_reason_ck`,
  jeden stĺpec, funguje bezpečne) — `(state = 'X') = (a IS NOT NULL AND b IS
  NOT NULL)` prepustí POLOVIČNE vyplnený riadok (`state != 'X'`, jeden z
  `a`/`b` vyplnený, druhý null), lebo pravá strana potrebuje byť len `false`,
  čo platí už pri JEDNOM null stĺpci, nie len pri OBOCH. Nájdené code review
  na PR #50 (`pairing_confirmation_ck`, #44), overené naživo proti Postgresu
  pred opravou. Správny tvar je explicitný dvojsmerný OR, ktorý vyžaduje OBA
  stĺpce zhodne v každej vetve:
  ```sql
  CHECK (
    (state = 'X' AND a IS NOT NULL AND b IS NOT NULL)
    OR (state != 'X' AND a IS NULL AND b IS NULL)
  )
  ```
  Test na KAŽDÝ ďalší viac-stĺpcový CHECK tohto tvaru: napíš test pre
  POLOVIČNÚ kombináciu (jeden stĺpec vyplnený, druhý null), nielen pre "oba
  vyplnené v zlom stave" a "oba prázdne v zlom stave" — presne tá tretia
  kombinácia je to, čo bare rovnosť tichο prepúšťa.
- **`onDelete: "set null"` na FK stĺpci, ktorý je súčasťou CHECKu viažuceho
  ho na `state` (vzor vyššie), NEMUSÍ reálne nikdy nastať** — ak CHECK
  vyžaduje ten stĺpec NOT NULL práve vtedy, keď je `state` v danom stave, set
  null vždy poruší CHECK skôr, než sa uplatní, takže Postgres delete odmietne
  s CHECK-violation namiesto FK-violation. Zistené code review na PR #50
  (`pairing.confirmed_by`, deklarované "set null" ako mirror
  `audit_events.actor_user_id`, ale `pairing_confirmation_ck` to nikdy
  nedovolí) — oprava bola zmeniť FK na `onDelete: "restrict"` (skutočné
  správanie sa nezmenilo, len sa zosúladil deklarovaný zámer s realitou).
  Test na KAŽDÚ ďalšiu takúto FK+CHECK kombináciu: over, či `onDelete` reálne
  vie nastať v STAVE, kde CHECK vyžaduje ten stĺpec vyplnený — ak nie,
  `restrict` je pravdivejší popis než `set null`/`cascade`.
- **`SELECT ... FOR UPDATE` (drizzle's `.for("update")`) BEZ `of` zoznamu
  zamyká riadky VO VŠETKÝCH tabuľkách JOINu, nielen v primárne vybranej** —
  Postgres dokumentácia: locking klauzuly bez `OF` zoznamu ovplyvňujú
  všetky tabuľky použité v príkaze. Review of PR 75, finding 3
  (`orders/queries.ts`'s `listOpenOrderLineIdsForSupplier`, ktorý JOINuje
  `order_line`/`order`/`variant`/`product`): presun tohto dopytu VNÚTRI
  transakcie `setSupplierLinesOrdered` (`state.ts`) spolu s `.for("update")`
  zatvoril TOCTOU okno (súbežný re-import/per-riadkový toggle už nemôže
  zmeniť "otvorenú" množinu medzi čítaním a zápisom) presne PRETO, že zámok
  pokrýva aj `order` riadok, nielen `order_line`. Deterministický regresný
  test (`tests/orders-supplier-bulk-lock.integration.test.ts`, rovnaká
  technika ako `orders-state-lock.integration.test.ts`) to dokazuje tak, že
  drží `SELECT ... FOR UPDATE` z druhého pripojenia na `order` riadku (NIE
  `order_line`) — obyčajný nezamknutý SELECT (stav pred opravou) by naň
  vôbec nečakal, takže test spoľahlivo zlyhá na starom kóde a prejde na
  novom. Rovnaký trik na ĎALŠIU takúto opravu: zamkni z druhého pripojenia
  tabuľku, ktorá je LEN súčasťou JOINu (nie tá, na ktorú priamo mieri
  finálny UPDATE) — ak sa volajúci kód naň zasekne, dôkaz, že `.for("update")`
  skutočne beží cez celý JOIN vo vnútri tej istej transakcie.
- **Funkcia, ktorá má bežať aj s `tx`, potrebuje zúžený parameter aj pre
  `.select()`, nielen pre `.insert()`** (rozšírenie vzoru vyššie z `audit/
  service.ts`'s `AuditExecutor`) — `orders/open-statuses.ts`'s
  `listOpenStatusNames` a `orders/queries.ts`'s
  `listOpenOrderLineIdsForSupplier` majú teraz `Pick<Database, "select">`
  namiesto celého `Database`, aby ich šlo volať aj s `tx` (`PgTransaction`
  nemá `Database`'s `$client`).
