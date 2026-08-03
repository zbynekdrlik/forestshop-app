---
paths:
  - "apps/api/src/modules/mail-log/**"
  - "apps/api/src/http/mail-log-routes.ts"
  - "apps/api/src/db/schema-mail-log.ts"
  - "apps/api/src/modules/mail/transport.ts"
  - "apps/web/src/mailLogApi.ts"
  - "apps/web/src/components/MailLog*.tsx"
  - "apps/web/tests/e2e/mail-log.spec.ts"
---

# Kniha odoslaných e-mailov (issue 193)

- **KAŽDÉ odoslanie e-mailu ide cez `sendLoggedMail` (`mail-log/service.ts`) —
  nikdy priamo cez `mailTransport(...)`.** Odoslanie a zápis do knihy sú
  zámerne v JEDNEJ funkcii: keby si každý odosielateľ zapisoval sám, ďalšia
  automatizácia by sa dala pridať tak, že na zápis zabudne — a presne to bol
  stav pred issue 193 pri VŠETKÝCH ŠTYROCH odosielateľoch naraz (nedostupné
  tovary, zásielky, pripomienky, objednávka dodávateľovi). Piaty odosielateľ
  preto NEPRIDÁVA vlastné logovanie, len zavolá `sendLoggedMail` s vlastným
  `MailLogContext`.
- **`sendLoggedMail` NEVYHADZUJE výnimku — vracia `{ ok: false }`.** Volajúci
  sa rozhoduje presne tak, ako to robil vo svojom pôvodnom `try/catch`. Pri
  prepise `try/catch` → `if (!ok)` si over, čo robila PÔVODNÁ `catch` vetva:
  v `posta-uncollected/run.ts` sa po zlyhaní e-mailu NEPRESKAKUJE zvyšok
  iterácie (zásielka musí ostať v zozname nevyzdvihnutých s pôvodným
  počítadlom) — `continue` by ju z výsledku ticho odstránil.
- **`recordSkippedMail` má 24-hodinové dedup okno na (automatizácia,
  objednávka, DOSLOVNÝ text dôvodu).** Preskočenie sa opakuje pri každom behu,
  kým trvá jeho príčina (objednávka bez e-mailu ju má aj zajtra) — bez okna by
  kniha rástla o ten istý riadok denne. **Dôsledok pre text dôvodu: nesmie
  obsahovať meniace sa číslo** (počet dotknutých objednávok, čas) — meniaci sa
  text okno obíde a riadok pribudne pri každom behu. Preto je v
  `order-reminder/run.ts` súhrnný riadok o chýbajúcom nastavení bez počtu.
- **Preskočenie sa zapisuje LEN keď appka SKUTOČNE chcela poslať** — chýbajúca
  adresa, chýbajúce nastavenie, zablokovaná duplicita, zlyhaná AI klasifikácia.
  Bežné „ešte nie je čas na ďalší e-mail" (kadencia zásielok, nevyriešená
  objednávka) sa NEZAPISUJE: nie je to pokus a kniha by sa stala nečitateľnou.
- **`DUPLICATE_REASON` (`mail-log/queries.ts`) je JEDEN zdieľaný reťazec** —
  súhrn „zabránené duplicity" ho porovnáva doslovne. Kto zapíše zablokovanú
  duplicitu vlastným textom, ticho vypadne zo súhrnu. To isté platí pre
  fixtúru v `scripts/e2e-setup.ts`.
- **Súhrn zámerne IGNORUJE filter stavu** (`summarizeMailLog` ho z filtra
  vypúšťa) — inak by pri zapnutom „len odoslané" tvrdil „zlyhalo: 0", hoci len
  nie je vidno. Filter automatizácie a obdobia sa naopak rešpektuje.
  `exactOptionalPropertyTypes` nedovolí `{ ...filter, status: undefined }` —
  filter sa musí zostaviť nanovo bez toho kľúča.
- **`mail_log` NIE JE koreňová tabuľka** — má FK na `users`, takže
  `TRUNCATE users CASCADE` ju v testoch vyprázdni sama (na rozdiel od
  `order`/`supplier_contact`, `.claude/rules/testing.md`). Do TRUNCATE
  zoznamov sa preto nepridáva.
- **História pošty prežije zmazanie zamestnanca aj šablóny** — `actor_user_id`
  je `on delete set null`, `template_key` je obyčajný text bez FK. Zmazanie
  účtu nesmie zmazať dôkaz o tom, čo odišlo zákazníkovi.
