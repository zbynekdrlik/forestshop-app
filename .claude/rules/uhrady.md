---
paths:
  - "apps/api/src/modules/uhrady/**"
  - "apps/api/src/http/uhrady-routes.ts"
  - "apps/api/src/db/schema-uhrady.ts"
  - "apps/web/src/components/UhradySection*"
  - "apps/web/src/components/PaymentScanCard.tsx"
  - "apps/web/src/uhradyApi.ts"
  - "apps/web/tests/e2e/uhrady.spec.ts"
---

# SLAVOSPORT → Úhrady (#543 — skeny FA na úhradu + jednoriadkové poznámky)

- **Účel:** miesto, kam Štěpán nahráva skeny papierových FA od dodávateľov, aby nezabudol uhradiť; po úhrade sken zmaže. Hore rýchle jednoriadkové poznámky (vzor daily-tasks, BEZ audia). Vidia to všetci prihlásení (zdieľané, nie per-user).
- **Uloženie:** obrázky ako bytea v Postgres (`schema-uhrady.ts`, vzor daily-tasks audio; zdieľaný helper `apps/api/src/db/bytea.ts`). Servované cez `GET /api/uhrady/scans/<uuid>` — plná veľkosť, thumbnail je CSS (object-fit), žiadny server-side downscale.
- **Popis skenu sa ukladá na BLUR** (nie Enter, nie tlačidlo). Playwright: `fill()` + klik mimo; syntetický `dispatchEvent(new Event('blur'))` React onBlur NEspustí — pri live-verify vždy reálna interakcia.
- **Mazanie skenu má in-app potvrdenie** („Áno, zmazať"/„Zrušiť") — nie native confirm(). Mazanie poznámky je bez potvrdenia (zámer).
- **Testids:** `uhrady-note-add`, `uhrady-file-input`, `uhrady-thumb-<id>`, `uhrady-desc-<id>`, `uhrady-delete-<id>`.
- **URL:** `/?tab=uhrady` (nav registry `apps/web/src/nav.ts`, sekcia SLAVOSPORT).
- **Mobil:** 390 px bez pretečenia — `min()`-strop vzor z issues 538/540/541; e2e to asserttuje.
- **Live-verify gotcha (Playwright MCP):** `browser_file_upload` berie len súbory v allowed roots (repo alebo `.playwright-mcp/`) — testovacie jpg nakopíruj tam, po overení zmaž.
