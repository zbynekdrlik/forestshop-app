---
paths:
  - ".github/workflows/ci.yml"
  - "apps/web/vite.config.ts"
---

# CI gotchas

- **`pnpm/action-setup@v4` sa v `ci.yml` volá BEZ `version:` inputu.**
  `package.json` má `packageManager: "pnpm@10.0.0"` — keď action dostane aj
  explicitný `version` input aj nájde `packageManager`, zlyhá s "Multiple
  versions of pnpm specified". Ak niekedy treba inú pnpm verziu, zmeň
  `packageManager`, nikdy nepridávaj `version:` k `pnpm/action-setup`.
- **`apps/web/vite.config.ts` musí mať `server.host: "127.0.0.1"`
  explicitne.** Bez toho Vite defaultne bindne na literálny string
  `"localhost"`, ktorý Node vyrieši JEDNOU DNS lookup — na GitHub Actions
  ubuntu runneroch sa to rozrieši len na IPv6 `::1`, zatiaľ čo
  `playwright.config.ts` (webServer readiness aj `baseURL`) mieri na
  `127.0.0.1`. Výsledok: appka beží a hlási sa ako pripravená, ale každý
  connect na `127.0.0.1` dostane okamžité `ECONNREFUSED`, až kým
  `webServer.timeout` (60s) nevzdá. Lokálne sa to nikdy neukázalo (tu sa
  `"localhost"` rozrieši na `127.0.0.1` ako prvé) — čisto rozdiel v poradí
  DNS/`getaddrinfo` na danom stroji, nie flaky test. Ak sa niekedy timeout e2e
  jobu znova objaví len na CI a nie lokálne, over TOTO ako prvé, predtým než
  sa timeout predlžuje — predlžovanie timeoutu by nič nevyriešilo (spojenie sa
  odmieta okamžite, nie pomaly).
- Console-assert výnimka pre e2e testy (jediná povolená: neautentifikovaný
  `/api/me` 401) je popísaná v `.claude/rules/testing.md` — rozširovanie tejto
  výnimky je zakázané, nie len pri práci na CI configu.
