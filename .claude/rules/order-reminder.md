---
paths:
  - "apps/api/src/modules/order-reminder/**"
  - "apps/api/src/http/order-reminder-routes.ts"
  - "apps/web/src/components/OrderReminder*.tsx"
  - "apps/web/src/orderReminderApi.ts"
---

# Pripomienky objednávok (issue 173)

- **Terminálne `resolution` (`contacted`/`emailed`) je TRVALÉ VŽDY — nikdy
  negate-ované fingerprint zmenou.** Ticketov popis ("objednávka, ktorá už
  bola vybavená a odvtedy sa jej dátum ani poznámka NEZMENILI, sa znovu
  nespracúva") číta sa ako podmienené ("len keď sa nezmenilo"), ale
  overenie priamo v starej appke (`parovanie_produktov/webreview/
  app.py:9013`) ukázalo, že jej `_reminder_is_terminal(prev)` skrat beží
  PRE has_note/e-mail/AI kontrolami pre KAŽDÚ objednávku vo `to_process`
  (teda aj tie, čo prišli ĎALEJ práve preto, že sa fingerprint zmenil) —
  fingerprint tam rozhoduje LEN o tom, či treba prepočítať zobrazovacie
  polia (rýchla vs. pomalá cesta), NIKDY o tom, či sa smie poslať druhý
  e-mail. `run.ts` preto gate-uje fast path na `existing?.resolution !=
  null` SAMOTNÝ (žiadny `fingerprint === fp` v podmienke) — inak by zmena
  poznámky PO odoslaní e-mailu poslala DRUHÝ e-mail (ticketova "presne
  jeden e-mail, navždy" podmienka). Regresný test:
  `order-reminder-run.integration.test.ts`'s "ZMENA poznámky po odoslaní
  e-mailu sa AJ TAK nespracuje druhýkrát". **Pri KAŽDEJ ďalšej
  automatizácii, ktorej ticket cituje starú appku's "inkrementálne
  spracovanie" popis** — over PRIAMO v starej appky's kóde (nie len v
  ticketovom zhrnutí), či fingerprint/inkrementalita SKUTOČNE gate-uje
  business rozhodnutie, alebo len zobrazovaciu optimalizáciu.
- **Ručný per-riadkový override (napr. "✓ Kontaktované"/"▶ Poslať
  ručne") mení LEN `order_reminder_state`, NIKDY posledný `job_run
  .detail`** — keďže `GET /api/order-reminder` (a teda celá obrazovka)
  číta VÝHRADNE z `job_run.detail` (rovnaký vzor ako #172), po úspešnej
  ručnej akcii by riadok zostal viditeľný v PÔVODNEJ skupine, kým
  nepríde ĎALŠÍ naplánovaný/manuálny beh — akcia by "zaúčinkovala" v DB,
  ale nie na obrazovke. Fix: `order-reminder-routes.ts`'s
  `relocateAfterOverride` — po úspešnom override načíta posledný
  `job_run` riadok tejto úlohy, vyhľadá pôvodný riadok vo VŠETKÝCH
  skupinách, vystrihne ho a pridá do správnej cieľovej skupiny (rovnaký
  zámer ako stará appka's `_relocate`), priamo prepíše `job_run.detail`.
  **Táto chyba bola chytená VLASTNÝM e2e testom pred pushom, nie
  neskorším review** — akákoľvek ĎALŠIA automatizácia s rovnakým tvarom
  (`job_run.detail`-driven zobrazenie + samostatný ručný override
  endpoint mimo hlavného behu) potrebuje TEN ISTÝ relocate krok, inak
  bude "funguje v DB, nevidno na obrazovke" bug čakať na objavenie.
- **Fixtúrová objednávka `"9002"` (`scripts/e2e-setup.ts`) je stabilný
  kandidát pre ĎALŠIE order-ÚROVŇOVÉ (nie order_line) e2e testy** — má
  `statusName` vo VÝCHODISKOVOM otvorenom stave, `placedAt` hlboko v
  minulosti (`2020-01-01`), a NIKDY nemá nastavený `shopRemark`/`email` (ani
  jeden existujúci test tieto polia nemení, len `order_line.state`/
  `ordered`). Bezpečný, deterministicky "bez poznámky ∧ bez e-mailu" riadok
  pre KAŽDÝ budúci order-úrovňový (nie riadkový) e2e test — netreba pridávať
  novú fixtúrovú objednávku, ak sa dá tento istý stabilný kandidát znovu
  použiť (ako sa to spravilo tu, namiesto ďalšieho rizikového pridania do
  zdieľaného zoznamu).
