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
- **issue 277: `mail_log.body` (aditívna migrácia `0038_sad_kinsey_walden.sql`)
  ukladá `message.text` pre KAŽDÉ odoslanie, nie len pre editovateľné cesty**
  — `sendLoggedMail`'s obe vetvy (`sent`/`failed`) teraz posielajú `body:
  message.text` do `insertEntry`. `recordSkippedMail` (preskočené) zámerne
  NEDOSTÁVA `body` — appka pri preskočení žiadny text nikdy nevygenerovala,
  takže `body` ostáva `null` (rovnaká disciplína ako `reason`/`subject`
  vyššie: pole existuje len tam, kde má appka čo zapísať). Toto je súčasť
  editovateľného náhľadu (`.claude/rules/nedostupne.md`'s `editedBody`) —
  kniha teraz vie dokázať, ČO presne odišlo, nielen komu/kedy. `MailLogSection
  .tsx` zobrazuje telo cez per-riadkové "👁 zobraziť text" tlačidlo (`row.body
  !== null`), nie vždy — dlhý text by rozbil hustú tabuľku.
- **issue 433: display meno odosielateľa má KÓDOVÝ default „Forestshop.sk"
  v `transport.ts`'s `applyDefaultSenderName` — nielen v env `MAIL_FROM`.**
  `resolveMailSender` obalí výsledok CELEJ fallback reťaze
  (`config.from ?? config.user ?? config.host`): ak string NEOBSAHUJE `<`
  (holá adresa/host), vráti `"Forestshop.sk" <adresa>` (RFC 5322
  quoted-string — bodka v „Forestshop.sk" nedovolí holý atom); ak už `<`
  obsahuje (`Meno <adresa>` tvar, vrátane produkčného
  `MAIL_FROM=Forestshop.sk <eshop@forestshop.sk>`), prenesie sa BEZ zmeny —
  explicitne nastavené meno sa nikdy neprepisuje. Bez holej adresy klienti
  zobrazovali lokálnu časť („eshop"). `replyTo` (issue 358) sa ZÁMERNE
  NEobaľuje — explicitný sa prenáša doslovne, nenastavený spadne na
  už-obalený `from` (adresa vo vnútri `<>` nezmenená, odpovede idú správne).
  Poistka je v jedinej odosielacej ceste, takže platí pre všetkých 5
  odosielateľov cez `sendLoggedMail`. Env tvar odosielateľa je preto
  `Meno <adresa>` (nie holá adresa) — a keďže default je aj v kóde, „eshop"
  sa pri strate/zmene `MAIL_FROM` už ticho nevráti.
- **`MAIL_BCC` NIE JE appkina premenná — je to MŔTVA env konfigurácia
  (pozostatok BCC-vždy konvencie starej appky).** `env.ts` `MAIL_BCC` v zod
  schéme NEMÁ (len v komentároch, ktoré vysvetľujú, prečo ho appka
  nepoužíva) — zod neznáme kľúče zahodí, takže hodnota z `.env` sa nikdy
  nenačíta. BCC, čo REÁLNE funguje, sa plní per-správa (`MailMessage.bcc` →
  `sendLoggedMail` → `mail_log.bcc`) zo ŠTYROCH samostatných, per-automatizácia
  premenných (`POSTA_UNCOLLECTED_BCC_EMAIL`/`ORDER_REMINDER_BCC_EMAIL`/
  `NEDOSTUPNE_BCC_EMAIL`/`ORDER_MERGE_BCC_EMAIL`, drôtované v `index.ts`),
  nikdy zo zdieľaného `MAIL_BCC`. Kto v budúcnosti uvidí `MAIL_BCC` v
  `/srv/forestshop/.env` a bude ho chcieť „napojiť": je to zámerné
  rozhodnutie (viď aj `.claude/rules/orders.md`), nie chýbajúce drôtovanie —
  BCC už funguje cez vyhradené premenné.
