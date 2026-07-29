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

## 2026-07-29 — #10 (self-service change-password screen + endpoint)

- Version bumped `55e2a97`→`4c86e4a` (0.3.0-dev.5 → 0.3.0-dev.6) as the first
  commit, before any feature code.
- Design posted BEFORE the implementation commit: root cause (only
  `modules/auth/service.ts`'s `login`/`logout`/`resolveSession` existed —
  no way to change an existing password other than
  `scripts/create-user.ts` or a manual DB `UPDATE` on dev2), chosen approach
  (`changePassword()` reusing `hashPassword`/`verifyPassword`/`hashToken`/
  `record()`, everything inside one `db.transaction` — same pattern as
  `catalog/ingest.ts`/`scheduler.ts`; new `POST /api/me/password` kept
  directly in `http/app.ts` next to `/api/login`/`/api/logout`/`/api/me`
  rather than a new routes file; new `MIN_NEW_PASSWORD_LENGTH = 8` in
  `passwords.ts`, the first real password-length floor in the repo),
  rejected alternatives (a separate `http/password-routes.ts` — unjustified
  for one endpoint this size; sending the new password twice to the
  server — match-checking is a pure client-side concern).
  Posted to #10 (`issuecomment-5121796661`).
- Single feature commit `b740502` (`Closes #10`): `modules/auth/
  change-password.ts`, `POST /api/me/password`, web `passwordApi.ts` +
  `ChangePasswordForm.tsx` wired into `App.tsx` for every logged-in role,
  full test coverage (service-level `change-password.integration.test.ts`,
  HTTP-level additions to `http.integration.test.ts`, web unit tests, and a
  real two-browser-context Playwright e2e case appended to `login.spec.ts`).
  No RED/GREEN split — new capability, not a regression fix
  (`tdd-workflow.md`'s "features: tests mandatory, order flexible" path).
- `record()` (`modules/audit/service.ts`) widened from taking the full
  `Database` type to `Pick<Database, "insert">`, so it can be called with a
  `db.transaction()` callback's `tx` too (a `PgTransaction` lacks
  `Database`'s own `$client` property) — pure widening, verified every
  existing caller (`catalog-routes.ts`, `auth/service.ts`) still passes the
  full `Database`, which structurally satisfies the narrower type.
- **Deliberate HTTP-status choice:** "wrong old password" returns 200
  `{ok:false, error}`, not a 4xx — same family as `/api/catalog/ingest`'s
  200 `{status:"busy"}` for a non-error domain outcome. A 4xx would make
  Chromium log a "Failed to load resource" console entry, which would have
  broken `testing.md`'s hard rule against widening the single documented
  e2e console exception (unauthenticated `/api/me` 401) to any more
  paths/codes. Discovered by writing the two-browser-context e2e test with
  console monitoring FIRST at 400 and watching it fail on exactly this —
  switched to 200 and updated the HTTP integration test + web unit test to
  match.
- Independent code-review subagent dispatched (`superpowers:
  requesting-code-review`): 0 Critical/Important; one Minor accepted as-is
  (`MIN_NEW_PASSWORD_LENGTH = 8` duplicated between `passwords.ts` and
  `ChangePasswordForm.tsx` — no shared package exists between `apps/api`/
  `apps/web` yet, and removing the client-side pre-check would reopen the
  same console-noise problem the 200-status design avoided).
- Shared PR: **#18** (`dev` → `main`), merged `6cd0f7bb`. CI: all 5 jobs
  green (check, integration, e2e, docker-build, version-check) on both the
  push-triggered and PR-triggered runs.
- Deployed + verified on https://forestshop-novy.newlevel.media
  (v0.3.0-dev.6 in DOM footer): wrong-old-password rejected with the
  expected message and zero console errors/warnings; successful change
  accepted using the LIVE owner account (`vychod@varos.sk`); logged out and
  confirmed the OLD password (`sokol-bystrina-jaseb-898`) now fails login
  while the temporary new one succeeds; changed the password back to
  `sokol-bystrina-jaseb-898` and confirmed via a final logout+login that it
  is restored exactly. Console during the whole live check showed only the
  already-documented `/api/me`/`/api/login` 401 patterns (expected,
  deliberate test actions), no genuine errors.
- Per-ticket Discord card fired (`notify --run-card`, confirmed delivered).

## #21 — Import objednávok zo Shoptetu (F3)

- Version bump `39a2436` (0.3.0-dev.8 → 0.3.0-dev.9), design comment posted
  BEFORE first code commit (https://github.com/zbynekdrlik/forestshop-app/issues/21#issuecomment-5123773711).
- Feature commit `4bc570e`: `modules/orders/{fetcher,parser,ingest}.ts` +
  unit tests (`parser.test.ts` 24, `fetcher.test.ts` 9) + integration tests
  (`orders-ingest.integration.test.ts` 8, `orders-ingest-lock.integration.test.ts`
  1), migration `0007_groovy_alice.sql` (unique index `order_line_order_variant_uq`),
  `cli/orders-ingest.ts` + `scripts/orders-ingest.ts`, `env.ts`/
  `docker-compose.prod.yml`/`Dockerfile` for `SHOPTET_ORDERS_URL`/`ORDERS_RAW_DIR`.
- Playbook commit `f95863d`: new `.claude/rules/orders.md` (pseudo-item
  filtering, duplicate-line summing, DST-aware datetime parsing, comment/
  state preservation, no-snapshot-table acceptance gate).
- Fix commit `3421bb2`: an adversarial review fork caught a literal NUL
  byte (0x00) that had landed in a template-literal Map key instead of a
  space — harmless functionally but made `git diff`/`gh pr diff` render the
  whole file as binary, defeating review. Fixed + hardened by switching to
  a Map-nested-in-Map key (no string-concatenation separator at all).
- Shared PR: **#27** (`dev` → `main`), merged `5228c8e`. CI: all jobs green
  (check, integration, e2e, docker-build, version-check) on push and PR
  runs, both before and after the NUL-byte fix.
- Deployed + verified on https://forestshop-novy.newlevel.media
  (v0.3.0-dev.9 in DOM footer, `/api/version` commit matches `5228c8e7`):
  zero console errors. Installed `SHOPTET_ORDERS_URL` in `/srv/forestshop/.env`
  (mode 600), restarted the app container, ran
  `docker compose exec app node apps/api/dist/cli/orders-ingest.js` against
  the REAL Shoptet export — 524 orders / 864 order_line rows written
  (51 unknown-variant items skipped, 1046 shipping/billing/discount pseudo
  items ignored), confirmed via `psql` row counts. Re-ran the same import a
  second time — counts stayed identical (idempotent upsert confirmed on
  real production data).
- Per-ticket Discord card fired (`notify --run-card`, confirmed delivered).
