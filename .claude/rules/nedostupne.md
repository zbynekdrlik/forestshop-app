---
paths:
  - "apps/api/src/modules/nedostupne/**"
  - "apps/api/src/http/nedostupne-routes.ts"
  - "apps/web/src/components/NedostupneSection*.tsx"
  - "apps/web/src/nedostupneApi.ts"
---

# Nedostupné tovary (issue 176)

- **Server-side vynútenie povinného náhľadu — jednorazový `previewToken`,
  nikdy len UI konvencia.** Prvá verzia (merge candidate) spoliehala len na
  to, že React komponent volá `/preview` PRED zobrazením tlačidla "Odoslať"
  — `/send` samotné nič nekontrolovalo, takže priame API volanie mohlo
  poslať e-mail bez toho, aby čokoľvek jeho obsah niekedy zobrazilo (nájdené
  code review PRED mergom PR #182, nie testom). Oprava: `preview-tokens.ts`
  vydá krátkodobý (15 min), JEDNORAZOVÝ token viazaný na presne (orderCode,
  variantCode, emailType) pri `/preview`; `/send` ho vyžaduje a KONZUMUJE
  (zmaže) PRED čímkoľvek iným, bez ohľadu na výsledok zhody. Rovnaký
  in-process `Map` vzor ako `login-rate-limit.ts` (jedna bežiaca inštancia,
  MVP rozsah — reštart appky tokeny zruší, v poriadku). Ďalšia automatizácia
  s ticketovou podmienkou "povinný náhľad pred odoslaním" potrebuje TEN ISTÝ
  mechanizmus, nie len frontend disciplínu.
- **ŽIADNY scheduler/`enabled` prepínač, na rozdiel od #172/#173** — táto
  automatizácia nemá žiadny naplánovaný beh (ticket nič také nežiadal).
  `GET /api/nedostupne` je VŽDY živý DB dopyt, nikdy `job_run.detail` cache.
  Jednoduchšie, žiadna zbytočná zložitosť (MVP) — nová podobná automatizácia
  BEZ plánovaného behu by mala rovnako vynechať settings/`job_run` vrstvu.
- **`product.related_codes` (text[]) — návrh náhrady zo Shoptetu, populovaný
  pri katalogovom importe z CSV `relatedProduct`/`relatedProduct2..8`**
  (`catalog/map-row.ts`'s `extractRelatedCodes`/`MAX_ALTERNATIVES=8`) — PRVÝ
  stĺpec je bare `relatedProduct` (NIE `relatedProduct1`), overené priamo na
  reálnej fixtúre. Vlastnosť PRODUKTU (rovnaký first-wins vzor ako
  `internalNote`/`supplier` v `ingest.ts`), nie variantu. Appka NEMÁ zdroj
  skutočnej Shoptet produktovej URL (overené na exporte — žiadny `url`/
  `seoUrl` stĺpec) — alternatívy dostávajú VŽDY klikateľný vyhľadávací
  fallback (`alternativeSearchUrl`), nikdy sa neintegroval starý marketingový
  XML feed (zámerne zamietnuté ako zbytočná nová externá závislosť).
- **Dedup (`nedostupne_state`) je serializovaný `NEDOSTUPNE_SEND_LOCK_KEY`
  (`787_878_006`) — bez zámku by dva súbežné klik-y na TEN ISTÝ (objednávka,
  variant, typ) mohli OBA prejsť dedup-check pred zápisom a poslať e-mail
  DVAKRÁT** (nájdené vlastným code review pred mergom). Rovnaký vzor ako
  #172/#173's RUN lock, len okolo jedného odoslania namiesto celého behu.
  `.claude/rules/scheduler.md`'s registry MUSÍ byť aktualizovaný pri KAŽDOM
  novom kľúči — 005 (`order-reminder`) aj 006 (toto issue) tam predtým
  chýbali, hoci kód sám kolízii predišiel správne.
- **`insertTestVariantForProduct` (`tests/helpers/orders.ts`) teraz podporuje
  `relatedCodes` — nová automatizácia/test potrebujúci alternatívy nemusí
  vkladať produkt/variant ručne, len odovzdať `{ relatedCodes: [...] }`.**
