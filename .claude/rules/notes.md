---
paths:
  - "apps/api/src/modules/note/**"
  - "apps/api/src/http/note-routes.ts"
  - "apps/api/src/db/schema-note.ts"
  - "apps/api/tests/note-http.integration.test.ts"
  - "apps/web/src/components/NotesSection*.tsx"
  - "apps/web/src/notesApi.ts"
  - "apps/web/tests/e2e/poznamky.spec.ts"
---

# Poznámky (issue 437/440/591)

- **`note` je ZDIEĽANÁ nástenka** — žiadny per-user filter, JOIN na `users` pre
  autora, zápisy kľúčujú len `eq(note.id)`. Trasy: `requireUser` (bez
  `requireRole`, Štěpán = rola `sef` musí vedieť všetko) + `requireSameOrigin` na
  mutáciách. Sekcia NEAUDITUJE žiadny zápis (create/resolve/delete/úprava textu).
- **Úprava textu (issue 591) = `PATCH /api/notes/:id/text`, telo `{ body }`** —
  stĺpec je `note.body`, preto JSON kľúč `body` (nie `text` ako pri Úlohách) a
  ZDIEĽANÁ zod schéma `createBody` (trim, min 1, max 2000) — validácia úpravy sa
  nesmie rozísť s vytvorením. Neznáme (medzitým zmazané) id → **200
  `{updated:false}`**, rovnako ako resolve/delete a súrodenecké `/text` trasy
  (Úlohy, Predajňa) — NIKDY 4xx: Chromium loguje každú 4xx do konzoly
  (`testing.md` issue 476). Prvá verzia vracala 404 podľa dizajnu ticketu,
  koordinátor to zvrátil v prospech tohto pravidla.
- **Inline editor (`NotesSection.tsx`) — klik na text ALEBO ✏️ otvorí `<textarea
  class="poznamka-edit-input">` (rovnaký vzhľad ako pole novej poznámky, zdieľané
  CSS pravidlo), Enter uloží, Shift+Enter = nový riadok (poznámky sú
  viacriadkové), Esc zruší, opustenie poľa (blur) uloží.** Naraz najviac jedna
  otvorená úprava. Mechanika proti dvojitému/zrušenému uloženiu:
  - **`editingIdRef` zapisujú VÝHRADNE obsluhy (otvor/zruš/ulož/catch), NIKDY
    render.** Prvá verzia ho syncovala v tele komponentu (`ref.current =
    editingId`, „latest ref" vzor) — review našiel, že render počas zápisu (kým
    `editingId` je ešte `row.id`) ref znova „nabil" a blur, ktorý prehliadač
    vystrelí po Enter (pole sa počas zápisu `disabled`), poslal DRUHÝ PATCH.
    „Latest ref" je správny na ČÍTANIE aktuálnej hodnoty, nie na guard, ktorý
    obsluha zámerne vynuluje skôr, než sa stav dobehne. Regres: unit test
    „Enter + blur → updateNoteText 1×".
  - Rozpísané texty sú PER POZNÁMKA (`drafts: Record<id,string>`, seed-if-absent
    pri otvorení, mazané pri úspechu/Esc/prázdnom/nezmenenom, `frontend-design.md`
    issue 381). Blur-uloženie A prebieha práve vtedy, keď používateľ klikol na B —
    keď zlyhá, text A ostane v `drafts` a po znovuotvorení A sa vráti (jeden
    zdieľaný draft by ho prepísal textom B). Úspech zavrie LEN svoju úpravu
    (`current === row.id ? null : current`).
  - Hodnota sa berie z udalosti (`e.currentTarget.value`), nie zo stavu — Enter
    hneď po písaní nikdy neuloží zastaraný text. Enter počas IME skladania
    (`nativeEvent.isComposing`) neukladá.
  - `updated:false` (poznámku medzitým niekto zmazal) → UI úpravu zavrie, ukáže
    „Poznámku medzitým niekto zmazal" a obnoví zoznam (nie „skúste znova", ktoré
    by nikdy neprešlo).
  - Klik na text NEotvorí úpravu, keď je riadok `busy` alebo je v okne označený
    text (`window.getSelection()`), aby sa dal skopírovať telefón/adresa.
  - Vedomé obmedzenie: klik na 🗑/checkbox TOHO ISTÉHO riadku počas úpravy so
    zmeneným textom najprv blurom uloží text a riadok je `busy`, takže samotný
    klik sa „stratí" — treba kliknúť znova.
- **E2E (`poznamky.spec.ts`) — riadok v úprave sa hľadá cez VLASTNÉ id
  (`poznamka-row-<id>` → `poznamka-body-/edit-input-/edit-<id>`), nikdy `hasText`**
  (text je počas úpravy v `<textarea>`, `testing.md` issue 342 pasca). Enter/Esc
  REÁLNYM `locator.press()`, nie `.fill()` (issue 150). Po Enter počkaj na
  `toHaveCount(0)` editora (zatvára sa až po potvrdenom PATCH) PRED `reload()`.
  Účet `e2e-poznamky@forestshop.sk` (vlastný, rate-limit priestor) má v súbore 3
  prihlásenia.
- **Pridanie ďalšieho pevného (`flex:0 0 auto`) prvku do `.poznamka-row` (✏️, issue
  591) zhodilo text na 0px pri ÚZKOM riadku** — 375px okno s RUČNE rozbaleným
  sidebarom (emoji e2e prepína 1280→375, sidebar ostane rozbalený): `<main>` 125px,
  riadok 77px, checkbox+✏️+🗑+gapy 78px > 65px obsahu → `.poznamka-content`
  (jediný flexibilný, `min-width:0`) namerane 0px, `toBeVisible` „hidden" (CI PR
  592). Fix v `@media (max-width:36rem)` ZA základnými pravidlami: `flex-wrap:wrap`
  + `.poznamka-content { flex:1 1 0%; min-width:min(10rem,100%) }`. `flex-basis`
  MUSÍ byť `0%`, nie `auto` (2000-znaková poznámka by pri `auto` zalomila obsah pod
  checkbox aj v rail-móde). Overené meraním: desktop 547px nezmenené, rail-mód
  162px v jednom riadku, rozbalený 375px → 65px na vlastnom riadku. Ďalšia ikona
  v riadku: zmeraj `getBoundingClientRect` obsahu pri 375px s rozbaleným sidebarom.
