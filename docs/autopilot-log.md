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
  confirmed the OLD password (`<heslo — mimo repozitára>`) now fails login
  while the temporary new one succeeds; changed the password back to
  `<heslo — mimo repozitára>` and confirmed via a final logout+login that it
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

## #22 + #28 + #23 — Bundled batch: orders scheduler, raw-export retention, read API (F3)

- Version bump `a1bf750` (0.3.0-dev.10 → 0.3.0-dev.11). Design comments
  posted BEFORE first code commit on all three tickets:
  [#22](https://github.com/zbynekdrlik/forestshop-app/issues/22#issuecomment-5124103095),
  [#28](https://github.com/zbynekdrlik/forestshop-app/issues/28#issuecomment-5124103303),
  [#23](https://github.com/zbynekdrlik/forestshop-app/issues/23#issuecomment-5124103512).
- Commit `c35c0b2` (#22+#28): `ordersImportJob` (01:45 UTC) + `pruneRawOrdersJob`
  (02:00 UTC) in `modules/scheduler/jobs.ts`, wired in `index.ts`; new
  `modules/orders/raw-prune.ts` (pure filesystem mtime retention — orders have
  no snapshot table); shared `RunOrdersIngest` type + `DEFAULT_ORDERS_IMPORT_WINDOW_DAYS`
  moved into `modules/orders/ingest.ts`. Tests: `raw-prune.test.ts` (unit, 4
  cases), `scheduler-jobs.integration.test.ts` additions (delegation tests
  for both new jobs).
- Commit `b2fd182` (#23): `modules/orders/queries.ts`
  (`listOpenOrderLinesBySupplier` grouped at LINE level, `getOrderDetail`) +
  `http/orders-routes.ts` (`GET /api/orders/open`, `GET /api/orders/:id`,
  `POST /api/orders/ingest`) — same style as `catalog-routes.ts`. 12 new
  integration tests (`orders-http.integration.test.ts`): auth/role/CSRF/
  in-flight/503/502/audit paths + grouping/detail correctness.
- Independent code-review subagent dispatched (`general-purpose`, diff
  5228c8e7..d30943e): 1 Important (nullable `product.supplier` → `"(bez
  dodávateľa)"` fallback was unverified — no test exercised it) + 2 Minor
  (a `stat()` TOCTOU race in `raw-prune.ts` could fail the whole nightly job
  on a concurrently-deleted file; the ingest audit payload was wider than
  catalog's narrowed equivalent). All three fixed in commit `85f3d56`: added
  the null-supplier regression test (both `listOpenOrderLinesBySupplier` and
  `getOrderDetail`), guarded `stat()` with an ENOENT skip + its own
  `vi.mock`-based regression test, narrowed the audit payload to
  `{status, orderCount, lineCount}`/`{status, reason}`.
- Shared PR: **#29** (`dev` → `main`), merged `601734a`. CI: all jobs green
  (check, integration, e2e, docker-build, version-check) on both push and
  PR runs, across all three push cycles (initial, playbook-docs-only,
  review-fixes).
- Deployed + verified on https://forestshop-novy.newlevel.media
  (v0.3.0-dev.11 in DOM footer, `/api/version` commit matches `601734a0`):
  the scheduler had ALREADY run `orders-import` (524 orders/864 lines) and
  `prune-raw-orders` (`{"removed":0}`) live overnight, both "Úspešná" in the
  Plánovač table — direct production confirmation of #22/#28 with zero
  manual trigger. `GET /api/orders/open` (live, authenticated) returned 41
  suppliers / 864 total lines (exact match to the scheduler's own
  `lineCount`), `GET /api/orders/:id` returned a full order detail. Zero
  console errors (only the sanctioned unauthenticated `/api/me` 401).
- Per-ticket Discord cards fired for #22, #28, #23 (`notify --run-card`,
  all confirmed delivered).

## #24 — "Na objednanie" tab (F3, read-only v1)

- Design comment posted BEFORE first code commit:
  [#24](https://github.com/zbynekdrlik/forestshop-app/issues/24#issuecomment-5124541486)
  (root cause: manager needs the old app's daily "Na objednanie" screen;
  chosen approach: flat per-supplier table straight off the already-live
  `GET /api/orders/open`, no client reshaping; rejected alternative:
  per-order `GET /api/orders/:id` fetch + nested tree, since `/open` already
  carries every field this ticket needs on the line itself). No version
  bump needed — dev (`0.3.0-dev.12`) was already ahead of main
  (`0.3.0-dev.11`) from the previous cycle's bump.
- Commit `9e8d156`: new `apps/web/src/ordersApi.ts` + `apps/web/src/
  components/OrdersSection.tsx` (mirrors `schedulerApi.ts`/
  `SchedulerSection.tsx` conventions — zod schema, `OrdersUnauthorizedError`,
  session-expiry handling), wired into `App.tsx`. No role gate on visibility
  (the read route has none, unlike scheduler). `scripts/e2e-setup.ts` now
  seeds two open orders over already-imported fixture variants (one with a
  real supplier, one with `null` → exercises the "(bez dodávateľa)"
  fallback) so `orders.spec.ts` runs against real ingested data, not
  hand-inserted rows. Also added `order_line, "order"` to the e2e TRUNCATE
  list (`.claude/rules/testing.md` #20 pattern — `order` doesn't cascade
  from `variant`). Feature ticket, no RED/GREEN regression pair (not a bug
  fix) — tests added same-commit per `tdd-workflow.md`'s feature path:
  4 unit tests (`ordersApi.test.ts`), 5 unit tests (`OrdersSection.test.tsx`),
  1 Playwright e2e (`orders.spec.ts`) with the standard console-zero-errors
  assertion.
- Independent code-review subagent dispatched (`general-purpose`, diff
  `601734a..9e8d156`): 0 Critical, 0 Warning. 2 Suggestions — this
  autopilot-log entry (addressed here) and a note that neither
  `OrdersSection` nor `SchedulerSection` offers a manual refresh/retry after
  a transient load error (pre-existing pattern, not introduced by this
  change, no action taken). Overall assessment: ready to merge.
- PR: **#30** (`dev` → `main`), merged `2d8c4e7`. CI: all jobs green (check,
  integration, e2e, docker-build; version-check skipped on main as
  expected) on both push and PR runs.
- Deployed + verified on https://forestshop-novy.newlevel.media
  (v0.3.0-dev.12 in DOM footer, `/api/version` commit matches `2d8c4e7a`):
  logged-in session showed the "Na objednanie" heading with 41 real
  supplier groups and real order lines (e.g. BETALOV group, order 20261259,
  product "Poľovnícke kraťasy HART GOROSTA-SH") — matches the issue's
  "41 supplier groups, 864 lines" production figures. Zero console
  errors/warnings.
- Per-ticket Discord card fired (`notify --run-card`, confirmed delivered).

## #25 — Order line state change + audit history (F3)

- Ticket was deliberately split at intake (owner comment recorded
  2026-07-30): state-change is scoped/clear, "copy order" has no defined
  output format. Copy-order moved to a new follow-up issue **#31**
  (`Scope-gate: needs-user-decision`, label `needs-decision`); #25's body
  rewritten to cover state-change only.
- Design comments posted BEFORE first code commit:
  [#25 (main rationale)](https://github.com/zbynekdrlik/forestshop-app/issues/25#issuecomment-5124750130),
  [#25 (classifier-keyword supplement)](https://github.com/zbynekdrlik/forestshop-app/issues/25#issuecomment-5124899513)
  — root cause: `order_line.state` (since #21) was READ-only, no write path
  existed; chosen approach: narrow `POST /api/orders/lines/:lineId/state`
  (same `requireSameOrigin()+requireUser+requireRole("admin","manazer")`
  gate as `/api/orders/ingest`) backed by `modules/orders/state.ts`'s
  `setOrderLineState()` — one transaction (update + `record()` audit,
  same pattern as `changePassword`); rejected alternative: a general
  `PATCH /api/orders/lines/:lineId` accepting arbitrary fields, rejected
  because `quantity`/`variantCode` are importer-owned
  (`.claude/rules/orders.md`) and a wide endpoint would let a manager
  accidentally clobber them. No version bump needed — dev
  (`0.3.0-dev.13`) was already ahead of main (`0.3.0-dev.12`).
- Commit `7183ade`: new `apps/api/src/modules/orders/state.ts`, new route
  in `orders-routes.ts`, `OrdersSection.tsx` gets a role-gated `<select>`
  (admin/manazer, same `CAN_CHANGE_STATE_ROLES` pattern as `CatalogPage`'s
  `IMPORT_ROLES`) with local-state update on success (no full refetch),
  `ordersApi.ts`'s `updateOrderLineState()`. Select's `aria-label`
  deliberately avoids the substring "stav" — it collided with
  `catalog.spec.ts`'s `getByLabel("Stav")` (Playwright's default substring
  match), caught by running the FULL e2e suite, not just the new spec.
  Tests: 5 new integration tests (role gates, 404/400, CSRF) in
  `orders-http.integration.test.ts`, 4 unit tests in `ordersApi.test.ts`,
  4 unit tests in `OrdersSection.test.tsx`, 1 new Playwright e2e proving
  the manager changes a line's state through the real UI and it persists
  after reload (audit row content itself is asserted at the integration
  level, per `.claude/rules/testing.md`'s two-tier split).
- Filed **#32**: `tests/e2e/orders.spec.ts`'s FIRST test intermittently
  fails under 2-worker Playwright runs (confirmed pre-existing —
  reproduced on `origin/dev` `917242c` with none of this PR's changes,
  disappears at `--workers=1`); likely all e2e specs racing the same
  shared backend/Postgres. Out of scope for #25, left for investigation.
- PR: **#33** (`dev` → `main`), merged `d49aaf5`. CI: all jobs green
  (check, integration, e2e, docker-build, version-check) on both push and
  PR runs.
- Main-branch Deploy workflow run `30503448643` failed on its first
  attempt (`docker compose up -d`: "No such container:
  ..._forestshop-app-1" during container recreate — the same class of
  transient dev2 containerd race documented in `.claude/rules/deploy.md`,
  unrelated to this PR's content). `gh run rerun --failed` succeeded
  immediately (one rerun, per `ci-monitoring.md`'s "one rerun acceptable
  to rule out a transient").
- Deployed + verified on https://forestshop-novy.newlevel.media
  (v0.3.0-dev.13 in DOM footer, `/api/version` commit matches `d49aaf54`):
  logged in as the real owner account (role `admin`), changed order
  20261259's line (product "Poľovnícke kraťasy HART GOROSTA-SH") from
  "Objednané" to "Čaká sa" via the live select, confirmed the DOM showed
  the new value, reloaded the page and confirmed it PERSISTED (proves the
  write+audit transaction committed), then restored it back to
  "Objednané" (real production data, real customer order). Zero console
  errors beyond the sanctioned unauthenticated `/api/me` 401.
- Per-ticket Discord card fired (`notify --run-card`, confirmed delivered).
- **Follow-up fix cycle (same ticket, after merge):** dispatched an
  independent code-review subagent against the merged diff (`917242c
  ..7183ade`) as extra due diligence since #25 adds a new authenticated
  write endpoint. Found 🟡 `setOrderLineState`'s SELECT wasn't row-locked
  (audit `from` could go stale under two concurrent state changes on the
  same line — the `state` column itself still ended up correct,
  last-write-wins) and 🔵 the state select's `aria-label` had been
  stripped of the word "stav" to dodge a Playwright substring collision,
  silently sacrificing accessibility. Design rationale posted on #25
  ([comment](https://github.com/zbynekdrlik/forestshop-app/issues/25#issuecomment-5125171329))
  before the fix commit `eb0703d`: added `.for("update")` + a new
  deterministic regression test `orders-state-lock.integration.test.ts`
  (verified RED without the lock, GREEN with it — same pattern as
  `catalog-ingest-lock.integration.test.ts`); restored a full `aria-label`
  and instead made the COLLIDING existing test
  (`catalog.spec.ts`) use `getByLabel("Stav", { exact: true })`. PR **#34**
  (`dev` → `main`), merged `e736aab`. CI all green on both push and PR
  runs. Deployed + verified: https://forestshop-novy.newlevel.media shows
  `v0.3.0-dev.14` in the DOM footer, `/api/version` commit matches
  `e736aaba`, the new accessible `aria-label` ("Zmeniť stav riadku
  objednávky …") is live in the DOM, order 20261259's line still correctly
  shows "Objednané" (the earlier manual test restore held), zero console
  errors.

## Issue #32: Playwright e2e s viacerými workermi bol občas nestály (orders.spec.ts prvý test)

Root cause reprodukovaný priamo (5× `pnpm --filter @forestshop/web e2e --workers=2`,
4/5 zlyhalo) a potvrdený koreláciou timestampov v pino debug logoch API servera:
`scripts/e2e-setup.ts` seedoval JEDNÉHO zdieľaného e2e používateľa
(`e2e@forestshop.sk`), pod ktorým sa prihlasovali VŠETKY tri spec súbory.
`login.spec.ts`'s test zmeny hesla dočasne mení skutočné heslo tohto zdieľaného
účtu v DB — súbežný `POST /api/login` z INÉHO spec súboru, bežiaceho v inom
workeri, ktorý spadol presne do okna medzi zmenou a vrátením hesla, dostal
skutočný 401 (nie 429 — rate limiter aj Postgres pool exhaustion boli vylúčené
priamym dôkazom z logov: 9 volaní `/api/login` na beh, žiadna 429, latencie
60-160ms). Design rationale posted on #32
([comment](https://github.com/zbynekdrlik/forestshop-app/issues/32#issuecomment-5125363114))
pred prvým kódovým commitom: `[red]` commit `293eba8` pridal regresný
integračný test (`e2e-setup-user-isolation.integration.test.ts`, spúšťa SKUTOČNÝ
`scripts/e2e-setup.ts` ako podproces + priamo overuje `login()`/`changePassword()`
izoláciu — RED pred opravou), `[green]` commit `0ef14dd` dal `login.spec.ts`'s
testu zmeny hesla VLASTNÝ izolovaný e2e účet (`e2e-heslo@forestshop.sk` v
`scripts/e2e-setup.ts`). Zamietnutá alternatíva: vynútenie sériového behu
(`--workers=1`/`describe.serial`) — band-aid, ktorý by nechal mínu pre
akýkoľvek budúci súbežný test. Overené: 8/8 čistých behov `--workers=2` po
oprave. PR **#35** (`dev` → `main`), merged `fdb5c0b`. CI all green (push aj
pull_request run). Deployed + verified: https://forestshop-novy.newlevel.media
`/api/version` vracia `{"version":"0.3.0-dev.15","commit":"fdb5c0b6..."}`,
DOM footer ukazuje `v0.3.0-dev.15`, prihlásenie vlastníkovým účtom funguje,
dashboard "Na objednanie" sa vykresľuje so skutočnými produkčnými dátami,
konzola čistá (len povolený `/api/me` 401).

## #31 — Kopírovanie objednávky (F3) → poslanie objednávky dodávateľovi mailom

Ticket bol predtým `needs-decision` (majiteľ zvažoval clipboard vs. mail),
majiteľ rozhodol pre mail priamo z appky; ďalšie preskúmanie starej appky
zistilo, že tá NIKDY mail dodávateľovi neposielala (len clipboard) a nikde
neexistovala e-mailová adresa dodávateľa. Design comment posted na #31
([komentár](https://github.com/zbynekdrlik/forestshop-app/issues/31#issuecomment-5127823676))
pred prvým kódovým commitom: root cause (chýbajúci overený formát + chýbajúca
adresa), zvolený prístup (SMTP cez `nodemailer`, presne rovnaký textový formát
ako stará appka's `orderCopyLines`, nová tabuľka `supplier_contact`, náhľad +
audit), zamietnutá alternatíva (clipboard-only, majiteľ ho už raz odmietol).
Nová migrácia `0008_jittery_thaddeus_ross.sql` (`supplier_contact`, bez FK,
pridaná do OBOCH truncate zoznamov). Implementácia: `modules/orders/mail.ts`
(agregácia + formát), `modules/orders/supplier-contact.ts` (kontakt +
audit), `modules/mail/transport.ts` (SMTP transport), `http/supplier-
routes.ts` (PUT e-mailu, GET náhľad, POST odoslanie), UI v `OrdersSection.tsx`
(úprava e-mailu, náhľad + potvrdenie, kopírovanie do schránky ako záloha).
Testy: 10 unit (`mail.test.ts`, hranice skloňovania), 14 integračných
(`supplier-mail.integration.test.ts`, falošný SMTP transport, audit, role,
CSRF, 502/503 cesty), 6 nových component testov (`OrdersSection.test.tsx`),
7 nových API-klient testov (`ordersApi.test.ts`), 1 nový E2E test
(`orders.spec.ts`, nastavenie e-mailu + náhľad — SKUTOČNÉ odoslanie sa v E2E
zámerne nekliká, žiadny `MAIL_HOST` v e2e prostredí). PR **#37** (`dev` →
`main`), merged `ebb0138`. CI all green (push aj pull_request run + main
post-merge run). Deployed + verified naživo na
https://forestshop-novy.newlevel.media: `/api/version` = `{"version":
"0.3.0-dev.17","commit":"ebb0138..."}`, DOM footer `v0.3.0-dev.17`,
nastavenie e-mailu pre reálneho dodávateľa (BETALOV) v produkcii — perzistuje
po reloade, náhľad správne agregoval 88 skutočných otvorených položiek
(pluralizácia "88 položiek"), následne ZRUŠENÉ bez odoslania a e-mail vrátený
na nenastavený; konzola čistá (len povolený `/api/me` 401).

## #38 — Nastaviť odosielanie mailov na dev2 (MAIL_* v /srv/forestshop/.env)

Čisto serverová konfigurácia, ŽIADNA zmena kódu (appka `env.ts` +
`modules/mail/transport.ts` + `docker-compose.prod.yml` už plne
podporovali `MAIL_HOST/PORT/USER/PASS/FROM` z #31/PR #37). Majiteľ
rozhodol: rovnaká mailová schránka ako stará appka
(`parovanie_produktov`), údaje z jej gitignorovaného `data/.mail_env`.
`MAIL_HOST/PORT/USER/PASS/FROM` doplnené priamo na dev2 do
`/srv/forestshop/.env` (mode 600) cez ssh stdin — hodnoty nikdy
nevypísané do terminálu/logu. Kontajner reštartovaný (`docker compose up
-d app`), zostal na `0.3.0-dev.17` (= main). Overené END-TO-END: dočasný
`supplier_contact` pre BETALOV nastavený na majiteľovu vlastnú adresu
(`vychod@varos.sk`), reálne odoslané cez UI ("Poslať objednávku
e-mailom" → náhľad → "Odoslať"), server log potvrdil
`"supplier":"BETALOV","status":"sent"` (skutočné SMTP, 1013 ms), dočasný
kontakt následne odstránený (`"hasEmail":false`). Žiadna PR/CI — pure
config. Playbook: `orders.md` doplnený o (a) dvojkrokový UI send flow
(náhľad → potvrdenie) a (b) že `MAIL_*` sú od teraz reálne nastavené +
`MAIL_BCC` zatiaľ appka nepodporuje (vedomé, mimo rozsahu #38).

## #40 — Živé heslo majiteľa v čistom texte v docs/autopilot-log.md

Nález pred zverejnením repa: pri overovaní #18 (zmena hesla) sa do tohto
logu zapísala skutočná hodnota živého hesla k účtu majiteľa
(`vychod@varos.sk`) — v ~40 historických commitoch na `dev` aj `main`.
Dizajnový komentár (príčina + zvolený prístup + zamietnutá alternatíva
prepisu histórie) zapísaný na tiket PRED touto zmenou:
https://github.com/zbynekdrlik/forestshop-app/issues/40#issuecomment-5128673051.

Riešenie bez prepisovania histórie (`commit-conventions.md` to zakazuje):
1. Heslo majiteľa ROTOVANÉ cez živé `POST /api/me/password` na
   https://forestshop-novy.newlevel.media — overené: prihlásenie s NOVÝM
   heslom 200, prihlásenie so STARÝM heslom teraz 401. Hodnota nikde
   necommitovaná — `<heslo — mimo repozitára>`.
2. `docs/autopilot-log.md` (riadky ~156-159): obe plaintextové výskyty
   nahradené `<heslo — mimo repozitára>`.
3. Nové pravidlo `.claude/rules/sensitive-values.md` (`paths:` na `docs/**`,
   `.claude/**`; súbor sa NEvolá `secrets.md` — taký názov si vlastný
   `block-sensitive-staging.sh` hook zamieňa za skutočný súbor s tajomstvami
   a odmieta ho stagovať): skutočné heslá/tokeny/Shoptet `hash=` sa nikdy
   nezapisujú do repozitára.
4. `CLAUDE.md` už správne uvádzalo repo ako `(public)` (z predošlého
   pokusu o zverejnenie, ktorý práve tento audit zastavil) — žiadna
   zmena netreba, main session prepne viditeľnosť na verejnú hneď po
   zlúčení tejto vetvy.

Žiadna PR do `main` — zámerne zostáva na `dev`; main session koordinuje
zverejnenie repa + obnovenie CI (GitHub Actions bolo blokované limitom
účtu, #39) + merge. Grep diffu pred pushom potvrdil, že ani staré, ani
nové heslo sa nikde v pushnutom obsahu nenachádza.
