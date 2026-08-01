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
treťou stranou a pod. — vrátane BEŽNÉHO post-deploy naživo overenia, ktoré
príde AŽ PO merge/deploy), NEPÍŠ `Closes #N` do tela PR — nechaj ticket
zavrieť RUČNE (`gh issue close`) až PO skutočnom overení, alebo (ak sa
merguje aj tak) rovno po merge over stav (`gh issue view --json state`) a
znovu otvor (`gh issue reopen`) s vysvetľujúcim komentárom, presne ako sa
to riešilo tu.

**Rovnaké riziko platí aj pre COMMIT SPRÁVY, nielen telo PR** (issue 66,
2026-08-01) — tento repo merguje dev→main VŽDY merge commitom (nikdy
squash), takže jednotlivé commit správy z `dev` ostávajú NEDOTKNUTÉ v
histórii `main` po merge; GitHub-ova detekcia zatváracích kľúčových slov
sa spúšťa aj z commit správy, keď taký commit skončí na predvolenej vetve.
`Closes #66`/`Fixes #66` v samotnej commit správe (nie len v tele PR) by
teda tickét zavrelo AJ BEZ akéhokoľvek riadku v tele PR. Fix: pri tickete s
odloženým overením napíš do commit správy PLAIN referenciu bez zatváracieho
slovesa (`issue 66`, nie `Closes #66`/`Fixes #66`), presne ako v tele PR.

**GitHub-ova detekcia zatváracích kľúčových slov chytá tvary slovies
zavrieť/opraviť/vyriešiť (v angličtine) BEZPROSTREDNE pred `#N` KDEKOĽVEK
v tele PR — bez ohľadu na slovné hranice, aj vnútri zloženého slova.**
Issues 127/132 (2026-08-01): telo PR NEMALO štandardný riadok pre
automatické zatvorenie, ale vetu popisujúcu predošlé PREDČASNÉ zatvorenie
tvaru "auto-" + sloveso v minulom čase + "#132" — GitHub to vyhodnotil
rovnako, akoby tam bol ten riadok priamo, a ticket znova ticho zavrel. Pri
PÍSANÍ o tickete v tele PR/komentári (mimo úmyselného riadku na
automatické zatvorenie) sa vyhni AKÉMUKOĽVEK z tých slovies (anglicky:
close/fix/resolve a ich tvary) bezprostredne pred číslom problému — aj v
zloženinách; ak treba opísať zavretie/opravu v
minulom čase, rozdeľ slovo a číslo ("bol predtým zavretý, viď #132") alebo
napíš číslo ticketu slovom ("issue 132" namiesto "#132" v danej vete).

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
- spätný zápis do Shoptetu (F5 — Playwright import, reálne admin cesty, Alpine chromium) → `.claude/rules/shoptet-writeback.md`
