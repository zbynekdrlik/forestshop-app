---
paths:
  - "apps/api/src/modules/pairing/**"
  - "apps/api/src/http/pairing-routes.ts"
  - "apps/api/src/db/schema-pairing.ts"
  - "apps/web/src/pairingApi.ts"
  - "apps/web/src/components/PairingSection.tsx"
---

# Kontrola párovania (F4, #45)

- **`GET /api/pairing` je LEFT JOIN `variant → product → pairing → users`,
  NIE INNER.** `pairing` tabuľka (#44) dnes nemá ani jeden riadok —
  automatické hľadanie kandidátov (budúca úloha #46) ešte neexistuje.
  INNER JOIN by preto vracal VŽDY prázdny zoznam, kým #46 nepristane.
  Chýbajúci riadok sa zobrazí ako `state: "navrhnute"` s `supplierUrl:
  null` (presne zodpovedá východiskovému stavu DB automatu, `queries.ts`'s
  `toItem()` robí `row.pairingState ?? "navrhnute"`) — filter podľa stavu
  preto v SQL používa `coalesce(pairing.state, 'navrhnute')`, nikdy holé
  `pairing.state = ...` (to by ticho vynechalo práve nespárované varianty).
- **`confirmPairing()` je JEDNA funkcia pre OBE akcie starej appky** ("✓
  potvrdiť" aj "zamietni a zadaj inú adresu ručne") — rozlišuje sa len
  podľa toho, či telo požiadavky nesie voliteľné `supplierUrl`: prítomné →
  prepíše uloženú/navrhnutú adresu a rovno potvrdí; chýbajúce → potvrdí
  AKTUÁLNE uloženú. Zámerne NIE JE samostatná "zamietni bez náhrady" trasa
  — pri dnešnom dvojstavovom automate (`navrhnute`/`potvrdene`) by nemala
  kam viesť (žiadny druhý kandidát na skúsenie, kým nepríde #46).
- **`variantCode` ide v TELE POST požiadavky, NIE ako cestový parameter.**
  Kódy variantov nesú lomku (napr. `"40237/3XL"`) — existujúca `/api/catalog/
  variants/:code` trasa (F1) má presne tento neoverený risk (z web klienta
  ju dnes nikto nevolá, takže sa nikdy neukázalo, či lomka v ceste vôbec
  prejde cez Hono/URL-encoding). Nová zapisovacia trasa (`POST /api/pairing/
  confirm`) sa tomuto riziku vyhla úplne — `variantCode` nesie zod-validované
  telo, žiadny cestový segment.
- **Web labely v `PairingSection.tsx` sú ZÁMERNE odlišné od `CatalogPage.tsx`'s
  rovnomenných prvkov na TEJ ISTEJ stránke** — "Kód variantu alebo produktu"
  (nie "Kód alebo názov"), "Stav párovania" (nie holé "Stav"), tlačidlo
  "Filtrovať" (nie "Hľadať"). Dôvod: `App.tsx` renderuje `CatalogPage` +
  `OrdersSection` + `PairingSection` + `SchedulerSection` NARAZ na jednej
  stránke; Playwright's `getByLabel`/`getByRole({name})` robia substring
  zhodu (case-insensitive) BEZ `exact: true` — rovnaký typ kolízie, aký #25
  našiel AŽ PO mergi (`.claude/rules/testing.md`). Tu bola nájdená a
  vyriešená PRED mergom kontrolou existujúcich `apps/web/tests/e2e/*.spec.ts`
  locator-ov (`grep -n 'getByLabel\|getByRole("button"'`) hneď pri písaní
  nového formulára. **Kontrolný zoznam pre KAŽDÝ nový `<label>`/tlačidlo na
  tejto zdieľanej stránke:** pred písaním e2e testu spusti ten istý grep cez
  VŠETKY existujúce `*.spec.ts` súbory a over, či text nového prvku (alebo
  jeho SUBSTRING) už niekde nefiguruje ako bare (nie `exact: true`)
  `getByLabel`/`getByRole` cieľ — ak áno, daj novému prvku odlišnejší text,
  nikdy neobetuj existujúci test.
- **Po úspešnom potvrdení sa `PairingSection.tsx` znova NAČÍTA (refetch),
  nie lokálna aktualizácia stavu** (na rozdiel od `OrdersSection`'s
  `changeState`, ktorá si vystačí s lokálnou úpravou). Dôvod: tabuľka
  zobrazuje AJ `confirmedByName`/`confirmedAt` — hodnoty, ktoré klient
  nepozná vopred (server ich odvodí z prihlásenej relácie a aktuálneho
  času). Skúšaný prvý pokus (lokálne nastaviť `state: "potvrdene"` bez
  týchto polí) prešiel unit testom, ale zlyhal v E2E (stĺpec "Potvrdil"
  ostal "—" aj po potvrdení) — chyba bola nájdená a opravená PRED mergom
  spustením skutočného Playwright behu, nie len unit testov s mockmi.
- **`scripts/e2e-setup.ts` má JEDEN zámerne PREDNASTAVENÝ, ešte
  nepotvrdený `pairing` riadok** (variant `"40287"`, žiadny dodávateľ) —
  simuluje to, čo by inak vložilo budúce #46. Bez neho by "✓ Potvrdiť
  jedným klikom" nemalo ako sa otestovať cez skutočný prehliadač (appka
  sama dnes žiadnu takú kombináciu — `state='navrhnute'` S vyplnenou
  adresou — nevytvorí; ručné zadanie adresy cez UI rovno aj potvrdzuje).
  Variant `"4859/46"` zostáva zámerne BEZ pairing riadku vôbec (testuje
  LEFT JOIN prípad namiesto toho).
- **Re-potvrdenie UŽ potvrdeného riadku s NEZMENENOU adresou je no-op —
  NIKDY neprepisuje `confirmedBy`/`confirmedAt`** (review nález na PR 54,
  issue 45, oprava v `state.ts`'s `confirmPairing()`): pred upsertom sa
  overí `existing?.state === "potvrdene" && existing.supplierUrl ===
  finalUrl`; ak platí, funkcia vráti `"ok"` bez zápisu (žiadny upsert,
  žiadny audit event). Bez tejto kontroly ktorýkoľvek ďalší klik na "✓
  Potvrdiť" (druhým manažérom, alebo aj tým istým znova) ticho ukradol
  attribution, hoci nebolo urobené žiadne nové rozhodnutie. Skutočná ZMENA
  adresy (ručná oprava cez "✗ Zadať inú adresu" na INÚ adresu) JE nové
  rozhodnutie — normálna cesta (upsert + audit) sa nemení. Web strana
  pridáva `item.state === "potvrdene"` do `disabled` na "✓ Potvrdiť"
  tlačidle — je to len UX vrstva (predchádza zbytočnému kliku), server
  ostáva skutočnou bránou (priamy API call/stale UI by inak obišiel
  disabled tlačidlo). Test na KAŽDÝ ďalší podobný "potvrď/ulož" endpoint,
  ktorý má koncept "kto a kedy": over, či opätovné volanie s NEZMENENÝMI
  dátami skutočne zachová pôvodnú attribution, nielen že vráti rovnaký
  HTTP status.
- **Integračný test-súbor pre párovanie je rozdelený DVOMA súbormi kvôli
  ESLint `max-lines` (400), NIE kvôli inej téme:** `pairing-http.
  integration.test.ts` (CRUD/HTTP správanie) a `pairing-reconfirm.
  integration.test.ts` (no-op re-potvrdenie, potrebuje DVOCH súčasne
  prihlásených manažérov — vlastný `withCleanDb()` helper, nie zdieľaný
  `boot()`). Ďalší test pre párovanie, ktorý by `pairing-http.
  integration.test.ts` posunul cez 400 riadkov, patrí do `pairing-
  reconfirm.integration.test.ts` (ak súvisí s re-potvrdením) alebo ďalšieho
  nového `pairing-*.integration.test.ts` súboru (inak) — nie do
  jedného rastúceho monolitu.
