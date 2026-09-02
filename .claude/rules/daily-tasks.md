---
paths:
  - "apps/api/src/modules/daily-tasks/**"
  - "apps/api/src/http/daily-tasks-routes.ts"
  - "apps/api/src/db/schema-daily-tasks.ts"
  - "apps/web/src/components/DailyTask*.tsx"
  - "apps/web/src/components/DailyTasksSection*.tsx"
  - "apps/web/src/dailyTasksApi.ts"
  - "apps/web/src/useVoiceRecorder.ts"
  - "apps/web/tests/e2e/daily-tasks.spec.ts"
---

# Úlohy na dnes / hlasová poznámka (issue 342/487/519)

- **`daily_task` je ZDIEĽANÁ tabuľka (#487)** — žiadny per-user filter, JOIN na
  `users` pre autora, zápisy kľúčujú len `eq(id)`; každý prihlásený smie
  odfajknúť/upraviť/zmazať/nahrať. Trasy: `requireUser` (bez `requireRole`) +
  `requireSameOrigin` na mutáciách. `DailyTasksSection` preto berie len
  `{onSessionExpired}`, nie celý `SectionProps`.

- **PRVÉ `bytea` v appke (#519, hlasová nahrávka na riadku `daily_task`).**
  - drizzle: `customType<{ data: Buffer }>({ dataType(){ return "bytea"; } })`;
    node-postgres nesie/prijíma `Buffer` bez extra serializácie.
  - **NIKDY nevyberaj `bytea` stĺpec do ZOZNAMU/odznaku** — inak sa poll nafúkne
    na megabajty. `listDailyTasks` vracia len `hasAudio: sql<boolean>\`(${dailyTask.audio} is not null)\`` (`IS NOT NULL` bytea nedetoastuje). Bajty sa
    streamujú samostatnou trasou `GET /:id/audio` (`getDailyTaskAudio`, jeden riadok).
  - **`c.body(buffer)` NEPREJDE `tsc`** (overload → `null`); vráť surový
    `new Response(found.audio, { status: 200, headers: {...} })` (Hono handler to
    smie) s `Content-Type` = uložený mime + `X-Content-Type-Options: nosniff`
    (mime je od klienta).
  - Úložisko = riadok, NIE disk (appka je jeden bezstavový kontajner; DB je jediné
    trvalé úložisko + záloha). `audio`/`audio_mime`/`audio_duration_ms` sú TRI
    NULLABLE stĺpce menené spolu, invariant drží kód (`createVoiceDailyTask`/
    `deleteDailyTaskAudio`), NIE CHECK (dvoj/troj-stĺpcový CHECK je pasca, `database.md`).

- **OpenAI Whisper prepis — vstrekovaný `TranscribeClient`** (zrkadlí order-reminder
  `ClassifyClient`; `index.ts` ho dodá LEN keď je `OPENAI_API_KEY`, inak audio-only).
  - **Whisper háda formát z PRÍPONY názvu súboru v multiparte, NIE z content-type** —
    nastav `voice.<ext>` (mapa MIME→prípona vo `voice.ts`), inak 400 „Invalid file
    format"; `;codecs=…` odstrihni pred mapovaním.
  - Prepis je SYNCHRÓNNy s `AbortSignal.timeout(20s)`; PRÁZDNy prepis = ZLYHANIE
    (Whisper na sk/cs halucinuje na tichu) → zástupný text „🎤 Hlasová poznámka",
    audio-only. Nahrávka sa VŽDY uloží (never-lose je server-side; zlyhanie SIETE
    pri uploade je vedomé MVP okno — owner re-nahrá).
  - Strop prepisu má VLASTNÝ cap (~2000, nie manuálny `max(300)`); pri skrátení
    NEREŽ uprostred surrogate páru (emoji → U+FFFD).

- **Upload endpoint (`POST /voice`, multipart):** `bodyLimit` (`hono/body-limit`)
  PRED `parseBody` (Content-Length aj počas čítania) + redundantný post-read cap;
  odmietni prázdne/drobné (<1 KB → 400) a nepodporovaný mime (allowlist → 400).
  **`durationMs` MUSÍ mať horný strop** (stĺpec je `integer`/int4 — bez capu by
  `99999999999` pretiekol a zhodil insert na 500); clamp `<= 86_400_000`, inak `null`.

- **`useVoiceRecorder` (MediaRecorder hook):**
  - **Dvojklik počas čakania na `getUserMedia` otvorí DRUHÝ mikrofónový stream** —
    `state` sa stane "recording" AŽ v `.then`, takže rýchly druhý klik v tom istom
    ticku prejde `state !== "idle"` guardom; poistka je SYNCHRÓNNy `startingRef`
    (ref, mení sa hneď), clearnutý v `.then`/`.catch`. Prvý stream by inak ostal
    navždy zapnutý (viditeľný únik mikrofónu).
  - Unmount cleanup nastaví `cancelledRef.current = true` — prepnutie záložky
    uprostred nahrávania nesmie z čiastočnej nahrávky vytvoriť úlohu.
  - `audio_duration_ms` ber z KLIENTSKEHO časovača, nie z `<audio>` (webm hlási `Infinity`).

- **Mobil vs desktop = ČISTO CSS** — pridávací riadok renderuje mikrofón (VŽDY) aj
  emoji picker; `@media (max-width: 36rem){ .ulohy-add-row .emoji-picker{ display:none } }`
  skryje emoji na mobile (mikrofón ho nahrádza), na desktope sú oba. Žiadna JS
  detekcia šírky.

- **Issue 538's fix opravil len RIADKY zoznamu (`.uloha-row`) — PRIDÁVACÍ
  riadok (`.ulohy-add-row`) mal presne tú istú triedu chyby, len s iným
  spúšťačom (follow-up k issue 538, žiadny nový issue — do-now cleanup).**
  `.ulohy-add-row` je tiež `display:flex` bez `flex-wrap`, a vstup
  (`min-width:8rem`=128px) je PEVNÝ, nie odvodený od `flex-basis:0%` ako
  `.uloha-row`ov flexibilný text. Rail-mód (predvolený stav appky pod
  ~640px, `Sidebar.tsx`) sa nepretečie — dostupná šírka `<main>` je tam
  dosť veľká. Až keď používateľ sidebar RUČNE ROZBALÍ na úzkom (390px)
  viewporte (`--fs-sidebar-width:250px` namiesto `--fs-sidebar-rail-
  width:72px`), dostupná šírka `<main>` klesne pod vstupov pevný
  min-width a riadok preteká — `flex-wrap:wrap` SAMO OSEBE nestačí, lebo
  vstup PRETEČIE aj SÁM na vlastnom riadku. Fix (rovnaký `@media
  (max-width: 36rem)` blok): `.ulohy-add-row { flex-wrap: wrap }` +
  `.ulohy-add-row input { min-width: min(8rem, 100%) }` (`min()`-wrapper
  vzor ako `.claude/rules/frontend-design.md`'s issue 382 grid entry —
  nad 8rem kontajnerovej šírky sa správa identicky, pod ňou sa zmrští
  namiesto pretečenia). **Test na KAŽDÝ ĎALŠÍ nález v TEJTO obrazovke:**
  keď sa opravuje pretečenie JEDNÉHO flex riadku (`.uloha-row`/`.ulohy-
  add-row`/budúci ďalší), skontroluj, či SUSEDNÝ riadok v tej istej
  sekcii nemá TÚ ISTÚ triedu chyby s iným trigger-scenárom (rail vs.
  rozbalený sidebar) — `.claude/rules/frontend-design.md`'s
  `flex-basis`/`min-width` pasce sa opakujú naprieč appkou, aj v RÁMCI
  jednej obrazovky.

- **Testy:**
  - Web komponentové testy NEMAJÚ auto-cleanup (žiadne `globals: true`) — každý
    nový `*.test.tsx` MUSÍ `import { cleanup }` a volať ho v `afterEach`, inak sa
    rendery hromadia a `getByTestId` padne na „Found multiple elements".
  - jsdom neimplementuje prehrávanie — `vi.spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue(undefined)` (alebo `.mockRejectedValue(...)` pre fail cestu).
  - Recorder flow: falošný `MediaRecorder` (stop() vyprodukuje blob + spustí
    `onstop`) + `navigator.mediaDevices.getUserMedia` mock; hook flow cez `renderHook`.
  - E2E: fake mikrofón cez `playwright.config.ts` `use.launchOptions.args`
    (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`); nahrávaj
    ≥~1,5 s, aby nahrávka prekročila 1 KB spodný strop; e2e nemá `OPENAI_API_KEY`,
    takže testuje AUDIO-ONLY fallback (objavenie riadku = dôkaz upload+uloženie).
    Test je self-contained (filtruj VLASTNÝ riadok, `daily_task` je zdieľaná #480).
