# Autopilot Log

Terse per-ticket log of autopilot-worker cycles: issue(s), commit SHAs,
RED→GREEN test names, key decisions, and the shared PR.

## 2026-07-29 — #4 (apps/api/tests/ under tsc -b) + #7 (local integration-test DB isolation)

- **#4** (rescoped remainder — `scripts/` half already done in `87ab34a`):
  new `apps/api/tests/tsconfig.json` (standalone, non-composite, mirrors the
  `scripts/tsconfig.json` pattern), wired into root `pnpm typecheck`; removed
  `apps/api/tests/*.ts` + `apps/api/tests/helpers/*.ts` from ESLint's
  `allowDefaultProject`; dropped the now-dead `"tests"` entry from
  `apps/api/tsconfig.eslint.json`. Commit `c0500e5`. No RED/GREEN (build
  tooling, not a bug fix).
- **#7** (local integration-test DB isolation via session `pg_advisory_lock`
  in `withCleanDb()`): RED `f217a5d` (`apps/api/tests/db-isolation-lock.
  integration.test.ts:47` — `pg_try_advisory_lock` from a second connection
  must fail while a `withCleanDb()` context is open; failed because no lock
  was taken yet) → GREEN `c6c95f0` (session lock on a dedicated `pg.Client`,
  new distinct key `TEST_DB_ISOLATION_LOCK_KEY = 787_878_100`, held from
  before TRUNCATE to `close()`). Review follow-up `f2e4160` (release the lock
  in a `finally` even if `pool.end()` throws).
- Shared PR: **#13** (`dev` → `main`), `Closes #4` + `Closes #7`, merged
  `bede7fc5`. Deployed + verified on
  https://forestshop-novy.newlevel.media (v0.3.0-dev.1 → catalog page +
  login/logout functional, zero console errors besides the documented
  `/api/me` 401 exception).
- Playbook-review follow-up PR **#14** (docs/version-bump only, `8c49956` →
  merged `c09a51d`): testing.md's stale "#7 unresolved" note replaced with
  the real fix description + the shared advisory-lock keyspace warning;
  local-dev.md gained the "standalone non-composite tsc project" pattern
  note. Version bumped to 0.3.0-dev.2 (main had caught up to dev's
  0.3.0-dev.1 after #13's merge). Deployed + verified (v0.3.0-dev.2 in DOM
  footer, zero console errors).
