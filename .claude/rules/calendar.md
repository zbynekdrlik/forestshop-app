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
- **Issue 382 (majiteľ chce vidieť TRI najbližšie udalosti, nie jednu):
  `resolveNextEvent(icsText, now)` sa premenovalo na `resolveNextEvents
  (icsText, now, limit)` — vracia ZORADENÉ pole (max `limit`, konštanta
  `NEXT_EVENTS_LIMIT = 3` v `constants.ts`), nikdy singulárny `T | null`.
  Rovnaká zmena prešla CELÝM reťazcom: `NextEventResult`'s `event` →
  `events` (`service.ts`), HTTP odpoveď `event` → `events`
  (`calendar-routes.ts`), zod schéma aj `NextCalendarEventCard.tsx`
  (mapuje pole na max 3 riadky). Žiadna INÁ logika (poradie, filtrovanie
  CANCELLED, celodenné/RRULE spracovanie) sa nemenila — len návratový
  tvar a orezanie na `limit`. Pri KAŽDOM ĎALŠOM "zobraz N namiesto 1"
  tickete v tomto module: rovnaký vzor (funkcia dostane `limit` parameter,
  vráti pole, `.slice(0, limit)` na konci), nie duplicitná druhá funkcia
  vedľa pôvodnej.
- **Issue 469 (majiteľ chce udalosti zo VŠETKÝCH kalendárov účtu, nie len z
  jedného): `GOOGLE_CALENDAR_ICS_URL` prijme VIAC adries oddelených čiarkou
  alebo novým riadkom → `readonly string[] | undefined` (spätne kompatibilné s
  jednou adresou = 1-prvkové pole).** Zmena je `env.ts` transform (nie
  `z.string().url()`, ktoré by zoznam odmietlo): `.optional().transform((raw,
  ctx) => …)` — split na `[,\n]`, trim, vynechať prázdne, validovať KAŽDÚ
  položku cez `z.string().url().safeParse`, pri neplatnej `ctx.addIssue({code:
  z.ZodIssueCode.custom, …}) + return z.NEVER`. **Chybová hláška transformu
  NIKDY neinterpoluje adresu** (tajný token je v ceste — vzor „secret in path"
  vyššie platí aj tu; test to overuje: `not.toMatch(/basic\.ics/)`). `index.ts`
  mapuje každú adresu na vlastný `createHttpIcsFetcher(url)` a odovzdá
  `readonly IcsFetcher[]` do `createNextEventService`. **Kým sa do
  `docker-compose.prod.yml` premietne, over ako pri každej env premennej
  (`.claude/rules/deploy.md`) — tu ale `GOOGLE_CALENDAR_ICS_URL` už MÁ riadok v
  compose (od #309), takže zmena hodnoty na viac-adresovú ide len cez
  `/srv/forestshop/.env`, žiadny nový compose riadok netreba.**
  - **Merge-then-group invariant (jadro #469):** `next-event.ts` sa rozdelilo
    na `collectUpcomingCandidates(icsText, now): Candidate[]` (per kalendár:
    BEGIN:VCALENDAR check + parse + expand + filter „ešte neskončila", BEZ
    sortu/grupovania) a `groupByDay(candidates, now, dayLimit)` (sort podľa
    začiatku + doterajšie zoskupenie po dňoch). `resolveNextEventsFromCalendars
    (icsTexts[], now, dayLimit)` = `flatMap(collectUpcomingCandidates)` →
    `groupByDay`. Kandidáti sa teda ZLÚČIA zo všetkých kalendárov, zoradia a AŽ
    POTOM zoskupia po dňoch — nikdy per-kalendár-then-concat. Keby sa
    zoskupilo per-kalendár a zreťazilo, deň s udalosťami z dvoch kalendárov by
    sa do `NEXT_EVENT_DAYS_LIMIT` započítal DVAKRÁT a poradie by nesedelo. Test,
    ktorý to ROZLIŠUJE: dayLimit 1, kalendár A má 10.+11.8., kalendár B má 11.8.
    → merge-then-group vráti len 10.8. (`["A 10.8."]`), per-kalendár-concat by
    dalo `["A 10.8.","B 11.8."]`. `resolveNextEvents(icsText,…)` ostáva ako
    tenký obal `resolveNextEventsFromCalendars([icsText],…)`, takže všetkých 35
    pôvodných testov platí bezo zmeny logiky.
  - **One-fails-all honesty doktrína žije v service, nie vo wiring vrstve:**
    `createNextEventService` stiahne fetchery cez `Promise.all` — jeden z N
    zlyhá → celý `refresh` odmietne → `ok:false` (nikdy čiastočný pohľad, ktorý
    by ticho skryl kalendár — presne problém z #469). Preto pole fetcherov
    (`readonly IcsFetcher[]`), nie „kombinovaný fetcher `() => Promise<string[]>`"
    postavený v `index.ts` — druhá voľba by presunula honesty-kritické správanie
    mimo unit-testovaného service. Cache/TTL/in-flight dedup bez zmeny (drží
    ZLÚČENÝ výsledok). Web karta (`NextCalendarEventCard.tsx`) sa NEMENÍ.
- **Issue 439 (majiteľ chce 3 najbližšie DNI s udalosťami, nie 3 udalosti):
  `NEXT_EVENTS_LIMIT` → `NEXT_EVENT_DAYS_LIMIT`, parameter `limit` →
  `dayLimit`. Záverečné `.slice(0, limit)` (prvých N udalostí) sa nahradilo
  ZOSKUPENÍM po kalendárnom dni:** iteruj `upcoming` (už zoradené podľa
  začiatku), kľúč dňa = `zonedDateKey(candidate.start)` (Europe/Bratislava —
  rovnaké pásmo ako `formatDateLabel`/`hasNotEnded`, takže sedí s vypísaným
  `dateLabel` aj pri celodenných VALUE=DATE), drž `Set<string>` započítaných
  dní; nový deň pridaj len ak `size < dayLimit`, inak `continue` (NIE `break`
  — `continue` je robustné aj voči teoretickému preplietaniu dní, ďalšie
  udalosti UŽ započítaných dní sa stále pridajú). Návratový tvar (ploché
  `NextCalendarEvent[]`), service/route/schéma aj karta ostali BEZ zmeny —
  karta už mapuje každú udalosť na riadok `📅 deň — názov`, takže "viac dní =
  viac riadkov, rovnaký formát" je zadarmo (žiadna zmena vzhľadu, zadanie to
  výslovne žiadalo). Dni bez udalosti do `Set`u nikdy nevstúpia (iterujeme
  len cez udalosti) → preskočia sa a NEMINÚ `dayLimit`. Živo overené na
  produkcii: 18. 8. (3 udalosti) + 19. 8. (1) + 26. 2. budúci rok (celodenná
  narodeninová, ~6 mes. medzera preskočená). Test, ktorý ROZLIŠUJE
  day-grouping od starého event-slicingu: jeden deň s VIAC udalosťami než
  `dayLimit` (dayLimit 1 → všetky udalosti toho dňa) a viac dní s viacerými
  udalosťami (dayLimit 2 → 4 udalosti) — výsledky, ktoré `.slice(0,limit)`
  nedokáže vyrobiť; testy len s 1 udalosťou/deň prejdú aj na starom kóde
  (nedokazujú nič nové).
- **Issue 520 (Štěpán: text kalendárového upozornenia príliš malý, +1px):
  `--fs-text-xs` (12px) a `--fs-text-sm` (13px, `app.css` §1 typografia)
  sú NÁHODOU presne 1px od seba** — `.next-calendar-event-row`'s
  `font-size: var(--fs-text-xs)` (issue 382's pôvodná voľba, zdôvodnená
  vyššie v tomto súbore výškou karty) sa tak dalo zväčšiť o presne 1px len
  prepnutím na susedný existujúci token, bez zavedenia novej surovej
  hodnoty (`.claude/rules/frontend-design.md`'s "reuse tokens" pravidlo).
  Overené naživo (Playwright, throwaway skript proti lokálnemu dev serveru
  s prepichnutým `window.fetch` na `/api/upozornenia/next-event` —
  `.next-calendar-event-card`/-row sa dá takto rendrovať bez reálneho
  `GOOGLE_CALENDAR_ICS_URL`): `getComputedStyle().fontSize` 12px pred,
  13px po. Pri KAŽDOM ĎALŠOM "zväčši/zmenši písmo o N px" tickete v tejto
  appke: NAJPRV skontroluj, či dva susedné `--fs-text-*` tokeny (`app.css`
  §1) už nie sú presne N px od seba, než zavedieš `font-size: Npx`/nový
  token — nie je to zaručené (napr. `-sm`→`-base` je len 0.75px), ale keď
  sedí, je to najlacnejšia a najkonzistentnejšia oprava.
