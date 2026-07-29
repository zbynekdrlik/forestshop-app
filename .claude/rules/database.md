---
paths:
  - "docker-compose.yml"
  - "docker-compose.prod.yml"
  - "apps/api/drizzle/**"
  - "apps/api/drizzle.config.ts"
  - "apps/api/src/db/**"
  - "apps/api/src/index.ts"
---

# Database / Docker

- **`postgres:18-alpine` zmenil default `PGDATA`** na
  `/var/lib/postgresql/<major>/docker` namiesto klasického
  `/var/lib/postgresql/data`. Named-volume mount priamo na
  `/var/lib/postgresql/data` preto crash-loopuje (image ho vyhodnotí ako
  "unused mount" a odmietne štart —
  `docker-library/postgres#1259`). Fix: obe compose súbory (dev aj prod)
  explicitne pinujú `PGDATA: /var/lib/postgresql/data` v `environment:` sekcii
  `postgres` služby. Ak niekedy vznikne ďalší compose súbor s Postgres 18+
  named volume, potrebuje ten istý pin, inak zopakuje presne tento pád.
- CI `integration`/`e2e` joby bežia Postgres bez volume mountu vôbec (services
  kontajner, efemérny) — tento problém sa tam nikdy neprejaví, len pri
  lokálnom/prod behu s perzistentným volume.
- **Migrácie bežia pri štarte aplikácie** (`apps/api/src/index.ts`), nie ako
  samostatný deploy krok — `deploy.yml` preto nemá vlastný migračný step,
  spolieha sa na to, že appka si to spraví sama pri boote kontajnera.
- **Drizzle-ov migrátor nedrží advisory lock.** Každá migrácia beží vo
  vlastnej transakcii (takže appka nikdy neobslúži polovične zmigrovanú
  schému), ale dve súčasne štartujúce inštancie by si mohli pretekať o rovnaké
  DDL. Netýka sa dnešného deploy flow (beží vždy presne jedna inštancia) —
  ak sa niekedy pridá druhá replika appky, toto sa musí doriešiť pred tým.
- **`drizzle-kit` 0.30.x nevie `db:generate`/`db:migrate`, keď jeden
  `src/db/schema*.ts` súbor cez `export * from "./other.js"` odkazuje na iný
  (napr. `schema.ts` re-exportuje `schema-catalog.ts`).** Jeho zabudovaný
  `esbuild-register` loader rieši `require()` čisto podľa Node-ovho klasického
  CJS resolvera — pri explicitnom `.js` (nutnom kvôli
  `verbatimModuleSyntax`/natívnemu ESM v `dist/`) nehľadá sesterský `.ts`
  súbor, takže padne na `MODULE_NOT_FOUND`, hoci `vitest`/`tsx` ten istý import
  bez problémov vyriešia. Fix: bump `drizzle-kit` na `^0.31.0` (vyriešené v
  0.31.10) — vymenil si interný TS loader a `.js → .ts` sesterský import
  vyrieši správne. Je to len devDependency (CLI, nie runtime `migrate()` v
  `index.ts`), takže bump nemení produkčné správanie; `drizzle-orm ^0.38.0`
  zostáva kompatibilné (interný `compatibilityVersion` check prejde). Ak
  pribudne ďalší `schema-*.ts` súbor s re-exportom, over `db:generate` hneď —
  ak `drizzle-kit` opäť klesol pod `^0.31.0`, toto je presne ten istý pád.
