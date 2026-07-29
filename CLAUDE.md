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
