---
paths:
  - "apps/api/src/modules/upozornenia/**"
  - "apps/api/src/http/upozornenia-routes.ts"
  - "apps/api/src/db/schema-upozornenia.ts"
  - "apps/web/src/upozorneniaApi.ts"
  - "apps/web/src/components/Upozornenia*.tsx"
  - "apps/web/tests/e2e/upozornenia.spec.ts"
---

# Upozornenia (issue 267)

- **`upsertUpozornenie()` (`modules/upozornenia/service.ts`) je JEDINÁ
  zapisovacia cesta pre NOVÉ upozornenie** — presne rovnaký princíp ako
  `.claude/rules/mail-log.md`'s "jediná odosielacia cesta". Budúci
  automatický zdroj (#268 nevyzdvihnutá zásielka, #269 vrátenie) volá TÚTO
  funkciu s vlastným `dedupKey`, nikdy vlastný `db.insert(upozornenie)`.
- **`upozornenie_dedup_key_uq` je ČIASTOČNÝ unique index
  (`WHERE resolved_at IS NULL`), nie plný.** Nájdené integračným testom PRED
  mergom (nie odhadom): bez `.where()` druhý výskyt toho istého `dedupKey`
  PO vyriešení prvého (napr. zásielka sa znova vyzdvihne a znova zastaví o
  mesiac neskôr) narazí na unique-violation namiesto vloženia nového riadku
  — `upsertUpozornenie`'s zámerné správanie je totiž "vyriešený riadok sa
  NIKDY neobnovuje, ďalší výskyt dostane VLASTNÝ nový riadok". Drizzle-orm
  (`^0.38.x`) podporuje toto cez `uniqueIndex(...).on(...).where(sql\`...\`)`
  — každý ĎALŠÍ dedup stĺpec s "kým je nevyriešené" semantikou potrebuje ten
  istý čiastočný index, nie obyčajný `uniqueIndex`.
- **Stav (nové/otvorené/odložené/vybavené) sa NEUKLADÁ — počíta sa vždy z
  troch nullable timestampov** (`seenAt`/`postponedUntil`/`resolvedAt`,
  `modules/upozornenia/status.ts`'s `computeStatus`). Zámerné: odložená
  karta sa má "v ten deň vrátiť späť" bez akejkoľvek novej naplánovanej
  úlohy (ticket to explicitne zakazuje) — počítaný stav je vždy správny pri
  čítaní, žiadny cron, čo ho má o polnoci preklopiť.
- **Odznak v ľavom menu (`countActionableUpozornenia`) MUSÍ použiť rovnaký
  predikát ako predvolený filter zoznamu** (nevyriešené A práve
  NEODLOŽENÉ) — inak číslo v menu a to, čo appka ukáže pri otvorení
  záložky, nesedia. Code review pred mergom (pôvodná verzia natiahla VŠETKY
  riadky do JS a filtrovala cez samostatnú `isActionableNow` funkciu — druhá,
  nezávisle udržiavaná implementácia tej istej podmienky, navyše zbytočný
  celý-tabuľkový sken): oprava je zdieľaná `notPostponedCondition(now)`
  (`queries.ts`), ktorú POUŽÍVA AJ `listUpozornenia`'s `WHERE`, AJ
  `countActionableUpozornenia`'s `COUNT(*) WHERE` — nikdy dve nezávislé
  implementácie tej istej podmienky (JS aj SQL), vždy JEDNA zdieľaná.
- **Odznak počtu (na rozdiel od "Na objednanie"'s `OrdersRemainingCountContext`,
  issue 147) sa číta PRIAMO v `App.tsx`** (`fetchUpozorneniaCount`, rovnaký
  vzor ako `automationStatus`/`fetchPostaUncollectedStatus`) — číslo musí
  byť známe HNEĎ po prihlásení, nie až po prvom otvorení záložky (na rozdiel
  od "Na objednanie", kde ho publikuje samotná obrazovka cez context).
- **Otvorenie záložky = "prečítané" (hromadné `POST
  /api/upozornenia/mark-seen`), nie per-kartové tlačidlo.**
  `UpozorneniaSection.tsx` volá mark-seen a AŽ POTOM `load()` — cez
  `mountedRef` guard (rovnaký vzor ako issue 251's StrictMode-bezpečný
  "mountedRef nastavený v tele efektu", `.claude/rules/frontend-design.md`),
  aby sa mark-seen spustil PRESNE RAZ za mount, nikdy znova pri zmene
  filtra "aj vybavené" (ten len refetchne `load()` bez mark-seen).
- **`updateOwnNote`/`deleteOwnNote` server-side vynucujú `source ===
  "vlastne"`** — karta zo zdroja "appka" nemá tlačidlá Upraviť/Zmazať vôbec
  vo frontende, ale to nestačí (rovnaká past ako `.claude/rules/
  nedostupne.md`'s povinný náhľad — front-end skrytie nie je vynútenie).
  Server vráti `updated`/`removed: false` namiesto chyby pri pokuse o cudziu
  kartu.
