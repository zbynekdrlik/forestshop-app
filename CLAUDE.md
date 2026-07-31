# forestshop_app — Project Instructions

## Rules

Global rules are inherited from `~/.claude/CLAUDE.md` (managed by airuleset —
https://github.com/zbynekdrlik/airuleset) and apply here in full. Do not restate
them here; this file carries only what is specific to this project.

## Project

Machine **dev1**, `~/devel/forestshop/forestshop_app`. Sibling of
`forestshop/parovanie_produktov` — a separate repo; never edit one from the
other's session.

Repo: `zbynekdrlik/forestshop-app` (public). Two-branch flow — `main`
(production) + `dev` (work). Fáza F0 (základ) je hotová: pnpm workspace
`apps/api` (Hono + Drizzle + PostgreSQL) a `apps/web` (React + Vite),
nasadenie na dev2 cez GHCR a Cloudflare tunel.

**`gh issue view <N>` (bez `--json`) na tomto repe padá** (`GraphQL: Projects
(classic) is being deprecated…`) — použi `gh issue view <N> --json
body,title,state,labels,comments` namiesto toho (žiadne Projects polia sa
nepýtajú, takže to prejde).

**`Closes #N` v tele PR zavrie ticket AUTOMATICKY v momente mergu — nie až po
nasadení/naživo overení.** Issue 120 (2026-07-31): PR malo `Closes #120`,
GitHub ho zavrel presne v čase merge commitu, hoci ticket mal ešte
neoverenú (na credential čakajúcu) akceptačnú podmienku ("naživo klikni a
over"). Keď ticket má AKÚKOĽVEK acceptančnú podmienku, ktorú nejde overiť
PRED mergom (živý klik vyžadujúci cudzie prihlásenie, manuálne potvrdenie
treťou stranou a pod.), NEPÍŠ `Closes #N` do tela PR — nechaj ticket
zavrieť RUČNE (`gh issue close`) až PO skutočnom overení, alebo (ak sa
merguje aj tak) rovno po merge over stav (`gh issue view --json state`) a
znovu otvor (`gh issue reopen`) s vysvetľujúcim komentárom, presne ako sa
to riešilo tu.

**Airuleset's `block-sensitive-staging.sh` (globálny `git add`/`git commit`
hook) hlási FALOŠNÝ pozitív na plný 40-znakový git SHA v ktoromkoľvek
súbore/commit správe** — jeho "40+ char hex blob (possible key/token)"
vzor nevie odlíšiť SHA1 hash commitu od skutočného leaknutého tokenu
(issue 78, `apps/api/tests/shutdown.integration.test.ts`: komentár
citujúci merge SHA blokoval `git add`). Fix nie je bypass (`# airuleset:
secret-ok`), je jednoduchý: v komentároch/commit správach citovať SHA
SKRÁTENÉ (7-8 znakov, `d19f8eae`), nikdy plných 40.

## Playbook router

Per-area rules live in `.claude/rules/<area>.md` with `paths:` frontmatter.
- local dev (Node/pnpm/ports) → `.claude/rules/local-dev.md`
- database / Docker (Postgres 18 PGDATA, migrations) → `.claude/rules/database.md`
- tests (unit vs integration split, e2e setup) → `.claude/rules/testing.md`
- CI gotchas (pnpm action, Vite host binding) → `.claude/rules/ci.md`
- deployment on dev2 → `.claude/rules/deploy.md`
- backups / restore → `.claude/rules/backups.md`
- katalóg zo Shoptetu (import, snapshoty, dostupnosť) → `.claude/rules/catalog.md`
- plánovač úloh (F2 — nočné joby, job_run, advisory zámok) → `.claude/rules/scheduler.md`
- objednávky zo Shoptetu (F3 — import, sčítanie riadkov, pseudo-položky) → `.claude/rules/orders.md`
- kontrola párovania (F4 — LEFT JOIN dizajn, confirmPairing, e2e label kolízie) → `.claude/rules/pairing.md`
- citlivé hodnoty (heslá/tokeny/hash= sa nikdy nepíšu do repa) → `.claude/rules/sensitive-values.md`
- frontend dizajn (vizuálne tokeny, nav registry, user-menu, e2e login rate-limit) → `.claude/rules/frontend-design.md`
- HTTP trasy (Hono, poradie registrácie literal-vs-`:param`) → `.claude/rules/http-routes.md`
