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

## 2026-07-29 — #12 (F2 job scheduler) + #3 (session cleanup job)

- Version bumped `bf44462`→`6464971` (0.3.0-dev.3 → 0.3.0-dev.4) as the first
  commit, before any feature code.
- Design posted BEFORE the implementation commit: root cause (no
  scheduler/cron infra exists; #8 punted the "how does it run periodically"
  decision here), chosen approach (own `job_run` table + tiny in-process
  tick loop, due-ness derived from the persisted table so it survives a
  restart, `pg_advisory_xact_lock` reusing `ingest.ts`'s exact pattern with a
  new distinct key `787_878_002` so a second replica never double-runs a
  job), rejected alternatives (host cron/systemd timer — #8 explicitly ruled
  it out; a scheduling library — 3 simple daily jobs don't need one).
  Posted to #12 (`issuecomment-5121249995`) and #3
  (`issuecomment-5121448774`, pointing back to #12's rationale since #3 is
  explicitly one of the three jobs on this same infra).
- No RED/GREEN commit split — both tickets are new capability (scheduler
  infra + a job that never existed before), not a regression fix to
  existing behavior, so this followed the "features: tests mandatory, order
  flexible" path (`tdd-workflow.md`) rather than `regression-test-first.md`.
  Full test coverage landed in the same commit: `isDue` unit tests
  (`apps/api/src/modules/scheduler/scheduler.test.ts`), a deterministic
  advisory-lock mutual-exclusion integration test (same pattern as
  `catalog-ingest-lock.integration.test.ts`), full wiring tests for all
  three jobs + the new `GET /api/scheduler/runs` route (role gating, empty
  state), a dedicated `cleanupExpiredSessions` integration test (boundary
  parity with `resolveSession`'s `gt`), web unit tests for the new
  `SchedulerSection` component, and an extension of the existing
  `login.spec.ts` e2e test asserting the "Plánovač" section's empty state
  with a clean console.
- Commit `a3b2568` (both jobs + scheduler infra + HTTP route + UI + e2e
  extension + `docs/stara-appka-inventar.md`, `Closes #12` + `Closes #3`),
  self-review follow-up `bc9249d` (fixed a layering violation found before
  merge: `modules/scheduler/jobs.ts` was importing the `RunIngest` type from
  `http/catalog-routes.ts` — inverted the repo's usual http→modules
  dependency direction; moved the type to `modules/catalog/ingest.ts` next
  to `CatalogIngestResult`, `catalog-routes.ts` now re-exports it).
- Shared PR: **#16** (`dev` → `main`), merged `3c2b46c7`. CI: all 5 jobs
  green (check, integration, e2e, docker-build, version-check) on both the
  push-triggered and PR-triggered runs.
- **Deploy hit a transient dev2 runner infra failure, unrelated to this
  PR's code** (no dependency changes at all in this PR): `docker compose
  pull app` failed extracting a layer — `link ... no such file or
  directory` from `/var/lib/containerd/io.containerd.snapshotter.v1.
  overlayfs/...` to a path inside `/root/.local/share/pnpm/store/v10/files/
  ...` — a corrupted/incomplete containerd content-store blob referenced by
  a hardlink inside the runtime image's own `pnpm install --prod` layer
  (Dockerfile installs prod deps fresh in the runtime stage, which bakes
  pnpm's hardlinked content-store into that same layer). Verified via `ctr
  --address /run/containerd/containerd.sock -n moby` that the failed
  snapshot (36721) and the missing blob were already cleaned up by
  docker/containerd's own rollback — nothing manual to remove, no
  disk-space issue (100G free). Reran the failed `deploy` job
  (`gh run rerun --failed`) and it succeeded cleanly on retry — a one-off
  transient extraction glitch, not a recurring pattern (grepped this repo's
  issues + `docs/autopilot-log.md` for prior "overlayfs"/"containerd"
  occurrences — none).
- Deployed + verified on https://forestshop-novy.newlevel.media (v0.3.0-dev.4
  in DOM footer + `/api/version`; live authenticated session already showed
  the new "Plánovač" section rendering its empty state — no scheduler tick
  has fired yet, next window is 01:00–01:30 UTC; `GET /api/scheduler/runs`
  called from within the live authenticated page returned `200 {"items":
  []}`; zero console errors/warnings; container logs clean, no scheduler
  errors).
- Two per-ticket Discord cards fired (`notify --run-card`, one per issue,
  both confirmed delivered).
