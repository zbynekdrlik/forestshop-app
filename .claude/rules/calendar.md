---
paths:
  - "apps/api/src/modules/calendar/**"
  - "apps/api/src/http/calendar-routes.ts"
  - "apps/web/src/calendarApi.ts"
  - "apps/web/src/components/NextCalendarEventCard*.tsx"
---

# Google kalendár — najbližšia udalosť (issue 309)

- **Toto NIE JE DB-backed "upozornenie" (`.claude/rules/upozornenia.md`),
  hoci karta sedí na tej istej nástenke.** `upsertUpozornenie` je pre
  položky s dedupKey/resolve/postpone semantikou (niečo, čo treba
  VYBAVIŤ). Najbližšia kalendárová udalosť je live read-through pohľad —
  vždy sa len AKTUÁLNE prepočíta, nikdy sa "nevybavuje". Vynucovanie
  takýchto dát do `upozornenie` tabuľky by znamenalo vymýšľať umelé
  resolve/dedup semantiky pre niečo, čo žiadne nepotrebuje. Rovnaká úvaha
  ako `posta-uncollected`'s "Spustiť teraz" STATUS vzor (nie jeho samotný
  automatický zdroj karty), nie zoznamový DB vzor.
- **Krátkodobá in-memory cache PRIAMO v module (`service.ts`, 15 min úspech
  / 2 min zlyhanie) namiesto scheduler jobu.** Netreba perzistenciu (dáta
  sa nemajú "vybaviť" ani prežiť reštart appky zmysluplne) — lazy fetch na
  request s TTL cache dosahuje presne to isté, čo by periodický job
  dosiahol, bez novej tabuľky/migrácie/`job_run` riadku. Zlyhanie fetchu sa
  NIKDY nenahrádza starou (možno už minulou) cachovanou hodnotou — radšej
  čestné "nepodarilo sa načítať" než riziko, že appka donekonečna ukáže UŽ
  MINULÚ udalosť ako "najbližšiu".
- **`node-ical` interpretuje `VALUE=DATE` (celodenné, plávajúce, bez TZID)
  udalosti podľa TZ BEŽIACEHO PROCESU** — overené priamo (rovnaký ICS
  vstup dá iný absolútny UTC okamih pod `TZ=UTC` než pod
  `TZ=Europe/Prague`). CI beží v UTC, produkcia má `TZ=Europe/Bratislava`
  (issue 293) — porovnávanie holých UTC okamihov pre celodenné udalosti by
  sa medzi CI a produkciou ticho rozišlo. Fix: `next-event.ts`'s
  `hasNotEnded` porovnáva pre celodenné udalosti KALENDÁRNY DEŇ cez
  `../../timezone.js`'s `zonedDateKey(instant, "Europe/Bratislava")`, nie
  `.getTime()` — Bratislava je vždy 0 až +2 h PRED UTC, takže spätné
  preformátovanie VŽDY pristane na tom istom kalendárnom dni bez ohľadu na
  to, v akom pásme node-ical pôvodne interpretovalo plávajúci dátum.
  Časovaná (TZID) udalosť porovnáva PRIAMO okamihy (`.getTime()`) — tie sú
  jednoznačné bez ohľadu na proces. Test pre KAŽDÚ ĎALŠIU prácu s
  celodennými (`VALUE=DATE`) hodnotami z `node-ical` v tomto module: over
  najprv, či sa dá vyhnúť priamemu porovnaniu okamihov, a preformátuj cez
  `zonedDateKey` namiesto toho.
- **`ical.sync.parseICS` NIKDY nehodí výnimku, ani na úplne nezmyselný
  vstup — overené priamo (node-ical 0.27.1), prázdny aj náhodný text
  obidva vrátia `{}`.** Appka preto potrebuje VLASTNÚ minimálnu kontrolu
  "vyzerá to vôbec ako kalendár" (`next-event.ts`'s `BEGIN:VCALENDAR`
  substring check) — inak by pokazený/nekalendárový feed (napr. HTML
  chybová stránka vrátená s HTTP 200) ticho vyzeral ako "žiadna
  nadchádzajúca udalosť" namiesto toho, aby nahlas zlyhal.
- **`ical.expandRecurringEvent(event, {from, to, expandOngoing: true})`
  funguje pre OBIDVA prípady (opakujúca sa aj jednorazová udalosť) —
  jednotná cesta v `next-event.ts`, žiadna samostatná vetva pre "nemá
  rrule".** `expandOngoing: true` je POVINNÉ pre "najbližšia = ešte
  neskončila" sémantiku (dispatch issue 309) — bez neho by viacdňová
  udalosť, ktorá začala PRED `now`, ale ešte neskončila, vôbec nebola
  medzi kandidátmi (overené priamo: s `expandOngoing:false` prázdne pole,
  s `true` správna inštancia).
- **Google-ova súkromná ICS adresa nesie tajný token PRIAMO V CESTE**
  (`/calendar/ical/<email>/private-<token>/basic.ics`), NIE len v query
  parametri ako Shoptet exporty (`hash=...`) — `catalog/fetcher.ts`'s
  existujúci `redactUrl` (prekrýva LEN query parametre) by tu NIČ
  neskryl. `calendar/fetcher.ts`'s chybové hlášky preto NIKDY
  neinterpolujú URL vôbec (ani prekrytú) — len status kód/typ zlyhania.
  Test na KAŽDÝ ĎALŠÍ zdroj, kde je tajomstvo v CESTE, nie v query: over,
  že žiadna chybová hláška/log nikdy nezreťazí `url`/`String(url)`.
- **Deep-review nález (PR 322): `page.waitForResponse(...)` MUSÍ byť
  zaregistrovaný PRED akciou, čo request spustí** (`upozornenia.spec.ts`)
  — inak Playwright zmešká response, ktorý doletel skôr, než sa naň
  začalo čakať. Prvý pokus (`toHaveCount(0)` hneď po prihlásení, bez
  `waitForResponse`) by prešiel aj VŽDY (komponent renderuje `null` aj
  počas načítavania, aj pri `configured:false`) — nedokazoval by nič.
