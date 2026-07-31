# Autopilot Log

Terse per-ticket log of autopilot-worker cycles: issue(s), commit SHAs,
RED→GREEN test names, key decisions, and the shared PR.

## 2026-07-31 — #115 (hourly orders sync + no more false "OK") + #116 closed obsolete

- STEP 0: #116 (remark on "Na objednanie") found ALREADY IMPLEMENTED via
  #65/#95/#111 (parser, API, `OrderLineRow.tsx`'s `.ord-remark`, truncation
  + tooltip, all with existing tests) — closed as obsolete, evidence:
  https://github.com/zbynekdrlik/forestshop-app/issues/116#issuecomment-5146716654
  Dropped from the batch; #115 proceeded solo.
- Version bump `b7e17dd` (0.3.0-dev.69→.70), first commit on `dev`.
- Design decision posted BEFORE the feature commit:
  https://github.com/zbynekdrlik/forestshop-app/issues/115#issuecomment-5146738208
- `381e47f` (feat): `Schedule` becomes discriminated union
  `DailySchedule | HourlySchedule` (`types.ts`); `isDue()`/`periodKey()`
  (`scheduler.ts`) periodize by UTC day (daily) or UTC day+hour (hourly);
  `ordersImportJob` → `{ kind: "hourly", minuteUtc: 45 }`. Tests:
  `scheduler.test.ts` (12, daily unchanged + new hourly boundaries incl.
  midnight rollover).
- RED `c5d2706` / GREEN `5f70a36`: `syncStatus.test.ts`
  ("posledný úspešný sync spred 3 dní…") failed against non-existent
  `computeSyncStatus`; `SyncSection.test.tsx`'s new stale-run test failed
  showing `✅ OK` for a 3-day-old run. Fixed via `apps/web/src/syncStatus.ts`
  (`computeSyncStatus`, threshold = 2× each channel's own configured
  cadence: orders 2h, catalog 48h) wired into `SyncSection.tsx`
  (`IngestChannel` now takes `now`/`staleAfterMs`). e2e `nav.spec.ts`
  proves it live against a seeded aged `job_run` (`scripts/e2e-setup.ts`,
  isolated test DB, never production) — required updating
  `login.spec.ts`'s two `getByRole("alert")` assertions with
  `.filter({ hasText })` since the new stale banner shares that role on
  the default "sync" tab (same collision-fix pattern as the existing
  `getByLabel` note in `.claude/rules/testing.md`).
- Post-review fixes (both 🔵, non-blocking, folded into the merge):
  `jobs.ts`'s `pruneRawOrdersJob` comment updated (was still describing
  the old daily orders cadence); this log entry itself was the second nit.
- PR #125 (`dev` → `main`), auto-merged per default policy once all gates green.

## 2026-07-31 — #117 + #118 + #119 (bundle: drop KÓD column, hide mail actions, big supplier icon button)

- Version bump `c8853bb` (0.3.0-dev.68→.69), first commit on `dev` after
  main caught up.
- Design decisions posted per-ticket BEFORE the feature commit:
  https://github.com/zbynekdrlik/forestshop-app/issues/117#issuecomment-5146452081
  https://github.com/zbynekdrlik/forestshop-app/issues/118#issuecomment-5146459218
  https://github.com/zbynekdrlik/forestshop-app/issues/119#issuecomment-5146459969
- Main feature commit `6531b04`: `col-code`/`ord-code-cell`/`.ord-size-inline`/
  `.ord-supplier-code` removed entirely (117); `orderScreenFlags.ts`'s
  `SHOW_ORDER_MAIL_ACTIONS` (default `false`) gates the two mail-action
  buttons + hint in `SupplierActionsPanel.tsx` (118), existing functionality
  tests moved intact to new `OrdersSection.mailActions.test.tsx` (flag
  forced `true` via `vi.mock`); supplier link restyled to a 36×36px icon
  button (`🔗`, `aria-hidden`), same `href`/`target`/`rel`/`aria-label`
  (119). Freed colgroup width: `col-product` 11.4%→17.4%, `col-supplier`
  9.2%→14%.
- CI round 1 failed on e2e: two assertions in `orders.spec.ts` were made
  stale by the diff itself — `toContainText("46")` (leftover variant-code
  fragment) and `not.toContainText("🔗")` (issue 99's admin-link check,
  now legitimately false since #119 adds its OWN 🔗 elsewhere in the row)
  — fixed in `e1e4afc`, verified locally first (21/21 e2e, 231/231 unit).
- PR #124, all gates green, `/requesting-code-review` (general-purpose
  subagent) surfaced 2 🔵: `shouldShowSizeLabel` left as dead code
  (its only call site was the removed KÓD cell) and a stale CSS comment
  referencing the now-deleted `.ord-supplier-code` — both fixed in
  `78dfb5e` (228/228 unit after removing 3 now-pointless tests).
- Merged `ca858df`. Main CI + Deploy green.
- Live verification (`forestshop-novy.newlevel.media`, `vychod@varos.sk`,
  39 real rows, 16 supplier groups) at 1280/1440/1600/1920px: version
  `v0.3.0-dev.69` read from DOM; KÓD header absent (9 columns, was 10);
  0 rows with `variantCode`/`externalCode` text anywhere; 0 order-number
  wraps; 0 `.orders-table-wrap`/`<th>` overflow; 0 page horizontal scroll;
  0 copy/email buttons or hint text (16/16 bulk "✔ Označiť skupinu" buttons
  still present); 31 supplier icon links, all ≥36×36px click target,
  target=_blank + rel containing noopener; 0 console errors/warnings on a
  fresh navigation. Row height at 1280px: min 79px, median 91px, **max
  114.5px** (target was <120px; before this PR: median 95px, max 173px,
  7/39 rows >120px) — target met. At 1440/1600/1920px max dropped to 98px.
- Playbook: no new gotcha filed — this bundle's live-measurement/colgroup
  method was already fully covered by existing `.claude/rules/
  frontend-design.md` entries (issues 105/107/111); the two review findings
  (dead code from a removed call site, a stale cross-reference comment) are
  process learnings already covered by `no-dropped-work.md`/code-review
  discipline, not new project-specific knowledge.

## 2026-07-31 — #64 (order-comment write path — "Na objednanie" poznámka)

- `PUT /api/orders/:id/comment` (`orders-routes.ts` + `state.ts`'s new
  `setOrderComment`) — transaction + `FOR UPDATE` + audit, same shape as
  sibling `setOrderLineState`/`setOrderLineOrdered`. `order.comment` column
  pre-existed (F3, ingest never overwrites it) — no migration.
- `OrderLineRow.tsx`'s "Komentár" cell becomes an editable input+save for
  `canChangeState` roles; `OrdersSection.tsx`'s `changeComment` updates
  every line sharing the edited row's `orderId` (comment is order-scoped).
- Enabling refactor (same PR): #31 mail-preview/send state+handlers
  mechanically extracted from `OrdersSection.tsx` into
  `useSupplierMailActions.ts` (no behavior change) to stay under eslint
  `max-lines: 400`.
- Deep code review (pre-merge) found one real Important issue: a save on
  row B of an order could silently clobber an unsaved draft on row A of
  the SAME order (both share `orderId`). Fixed with an `isCommentDirty`
  ref guard in `OrderLineRow.tsx`. RED regression test:
  `OrdersSection.comment.test.tsx` "nerozostavaný koncept na riadku A
  PREŽIJE uloženie poznámky cez riadok B" — confirmed RED against the
  pre-fix code (`79480c6`), GREEN after (`03186ca`).
- New backend tests: `orders-http-comment.integration.test.ts` (6). New
  frontend tests: `ordersApi.test.ts` (+3), `OrdersSection.comment.test.tsx`
  (5, incl. the regression test above). New e2e test in `orders.spec.ts`
  under a fresh isolated account (`e2e-komentar@forestshop.sk` — the
  shared `e2e@forestshop.sk` was already at `MAX_ATTEMPTS=10` across all
  spec files) plus two pre-existing tests fixed for the new UI colliding
  with them (`{exact:true}` on a substring-matched "Uložiť" button;
  `toContainText`→`toHaveValue` since the comment moved from text to an
  `<input>`).
- PR #93, merged `6b57422e`, deployed + verified live (v0.3.0-dev.51):
  wrote a note on order 20261228 (2 lines) via one row's input, confirmed
  it appeared on BOTH lines before any reload, confirmed it survived a
  reload, then cleared it back to the original empty value via the same
  UI flow — restored state confirmed via DB query (`comment` = NULL) and a
  second reload. 0 console errors/warnings throughout.

## 2026-07-31 — #86 (supplier-assignment write-side gaps, found by independent audit of #63)

- **Finding 1**: `assignOrderLineSupplier` (`supplier-assignment.ts`) never
  re-checked `products.supplier IS NULL` — the rule was enforced only in
  the frontend (`OrderLineRow.tsx`'s `supplierAssignable`). Fix: SELECT now
  joins `products`, condition evaluated inside the same transaction as the
  upsert; new `"already_has_supplier"` result mapped to HTTP 409 in
  `orders-routes.ts`. No frontend change needed — `ordersApi.ts`'s
  `readJson`/`serverErrorMessage` already surfaces any `{error}` body on
  any non-200 status via the existing `stateError` banner.
- **Finding 2**: `orderLineSupplierBody` had no `.max()` — added `.max(200)`
  to match `catalog-routes.ts`/`pairing-routes.ts`.
- Design comment (root cause + rejected alternative — no extra
  `.for("update")` lock, same reasoning as the file's existing comment)
  posted BEFORE the first code commit: issue #86 comment
  `#issuecomment-5137353081`.
- Tests: RED `d0eaae8` (`orders-supplier-assignment.integration.test.ts` —
  409 + no override row written; 400 on a 201-char supplier) → GREEN
  `0d94d75` (both checks implemented).
- Verified live on production (`https://forestshop-novy.newlevel.media`):
  direct `fetch()` on a TRIGONA-group line returned 409 with the Slovak
  message, `product_supplier_override` stayed empty; a 201-char supplier
  returned 400 (Zod `too_big`). Then a real "(bez dodávateľa)" line was
  assigned via the UI (moved into a new 1-line group, exactly one override
  row appeared), the row was deleted directly in Postgres afterward, and a
  reload confirmed production data back to its original state exactly:
  "(bez dodávateľa) (3)", "Ostáva vybaviť 39 z 39", 0 lines `ordered`,
  `product_supplier_override` back to 0 rows.
- Commits: `0ac370a` (version bump 0.3.0-dev.46) → `d0eaae8` (red) →
  `0d94d75` (green).
- CI green (version-check/check/integration/e2e/docker-build) on `dev`
  push and PR `#87`; main CI + Deploy green on merge `64662ba`; live
  `/api/version` matched (`0.3.0-dev.46` @ `64662ba`).
- Shared PR: `#87`. Playbook: `orders.md` gained two entries — "a
  read-side computed rule (`supplierAssignable`) must be independently
  enforced by the write path, not just hidden by the frontend" and
  "`readJson`/`serverErrorMessage` already handles any new HTTP error
  status on an existing write route, no frontend change needed."

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

## 2026-07-30 — #44 (F4: databázový základ pre párovanie tovaru)

- Verzia: `0.3.0-dev.19` → `0.3.0-dev.20`, commit `4787db3` (prvý na `dev`,
  pred design komentárom overená verzia bump-founa).
- Design komentár (root cause + zvolený prístup + zamietnutá alternatíva
  `supplierId` FK) zapísaný PRED prvým kódovým commitom:
  https://github.com/zbynekdrlik/forestshop-app/issues/44#issuecomment-5129250113.
- Nové `apps/api/src/db/schema-pairing.ts`: `supplier` (PK `name`, mirror
  `supplier_contact`'s text-keyed konvencie) + `pairing` (`variant_code`
  UNIQUE FK na `variant.code` — štrukturálna oprava starej appky, kde sa
  dve veľkosti jedného produktu nikdy nepotvrdili naraz). `users`/
  `sessions`/`audit_events` presunuté z `schema.ts` do nového
  `schema-users.ts` (schema.ts je teraz čistý barrel), aby sa predišlo
  kruhovému importu. Commit `98e54d5` (13 integračných testov v
  `pairing-schema.integration.test.ts`, TRUNCATE zoznamy aktualizované).
- **Nájdené code review pred mergom** (`superpowers:requesting-code-review`):
  `pairing_confirmation_ck`'s pôvodná jednoduchá rovnosť (rozšírenie
  jednostĺpcového vzoru `catalog_snapshot_reason_ck` na dva stĺpce)
  nesprávne prepúšťala POLOVIČNE vyplnený riadok (`state='navrhnute'` +
  vyplnený len jeden z `confirmed_by`/`confirmed_at`) — overené naživo
  proti Postgresu. Migrácia bola len v lokálnom sandboxe (nikdy
  nemergnutá), preto opravená priamo v tej istej `0009` migrácii
  (`0009_melodic_rick_jones.sql` → `0009_sleepy_marauders.sql`,
  explicitný dvojsmerný OR), nie ako ďalší incremental krok. Fix commit
  `421a17b` (+2 regresné testy pre obe polovičné kombinácie).
- E2E job na push-triggerovanom CI behu raz zlyhal na
  `orders.spec.ts:62` (nesúvisiaci multi-worker flake, `.claude/rules/
  testing.md`'s zdokumentovaná trieda #32) — pull_request beh na tom
  istom commite prešiel zeleno; jeden rerun potvrdil transientnosť.
- Shared PR: **#50** (`dev` → `main`), `Closes #44`, merged `71e66a7`.
  Deployed + verified na https://forestshop-novy.newlevel.media
  (v0.3.0-dev.20, DOM verzia + `/api/version` sedia s merge commitom;
  živá Postgres na dev2 potvrdzuje opravený CHECK aj všetky FK/indexy
  presne podľa schémy).
- Drobné postrehy z review (chýbajúci index na `pairing.confirmed_by`,
  case/whitespace normalizácia `supplier.name` joinu) zaznamenané na
  #46 a #48 pre budúce úlohy — žiadna zmena v tomto PR.

## 2026-07-30 — #45 (F4: obrazovka "Kontrola párovania")

- Verzia: `0.3.0-dev.23` → `0.3.0-dev.24`, commit `276fcd1` (prvý na `dev`,
  pred design komentárom).
- Design komentár (root cause + zvolený prístup + zamietnutá alternatíva
  samostatnej "reject bez náhrady" trasy) zapísaný PRED prvým kódovým
  commitom: https://github.com/zbynekdrlik/forestshop-app/issues/45#issuecomment-5129954514.
- Nové `apps/api/src/modules/pairing/{queries,state}.ts` +
  `http/pairing-routes.ts` (`GET /api/pairing`, `POST /api/pairing/confirm`)
  + web `pairingApi.ts`/`PairingSection.tsx`, zapojené do `App.tsx` vedľa
  `OrdersSection`. **LEFT JOIN, nie INNER** na `pairing` (dnes nemá ani jeden
  riadok — automatické hľadanie kandidátov #46 ešte neexistuje) — chýbajúci
  riadok sa zobrazí ako "navrhnuté" s prázdnou adresou, presne zodpovedá
  DB automatu, a manažér tak môže párovať RUČNE od prvého dňa. Jedna funkcia
  `confirmPairing()` pokrýva obe akcie starej appky ("✓"/"zamietni a zadaj
  inú adresu ručne") podľa toho, či telo nesie `supplierUrl` override.
  `variantCode` ide v TELE POST, nie v ceste (kódy nesú lomku, napr.
  "40237/3XL" — existujúca `/api/catalog/variants/:code` trasa má tento istý
  neoverený risk, ale z web klienta ju dnes nikto nevolá).
- `escapeLikePattern` (`modules/catalog/queries.ts`) exportovaná na
  zdieľanie s `pairing/queries.ts` namiesto duplicitnej kópie.
- Nové labely v `PairingSection.tsx` ("Kód variantu alebo produktu", "Stav
  párovania", tlačidlo "Filtrovať") zámerne ODLIŠNÉ od `CatalogPage.tsx`'s
  "Kód alebo názov"/"Stav"/"Hľadať" — rovnaká trieda gotcha ako #25
  (`getByLabel`/`getByRole` substring zhoda na tej istej stránke), tentokrát
  vyriešená PRED mergom, nie až dodatočným review nálezom.
- Testy: 15 integračných (`pairing-http.integration.test.ts` — LEFT JOIN,
  filter podľa stavu, fulltext, potvrdenie s/bez ručnej adresy, 404/400,
  role/CSRF), unit testy `pairingApi.test.ts`/`PairingSection.test.tsx`
  (komponent po úspešnom potvrdení znova NAČÍTA stránku výsledkov —
  `confirmedByName`/`confirmedAt` sú AUTORITATÍVNE zo servera, nie
  odhadnuté klientom, rovnaký vzor ako `CatalogPage`'s `runIngest`), 2 nové
  Playwright e2e (`pairing.spec.ts` — jeden LEFT JOIN prípad nad variantom
  "4859/46" bez existujúceho pairing riadku, druhý s `scripts/e2e-setup.ts`'s
  novým zámerne prednastaveným NEPOTVRDENÝM kandidátom pre "40287", jediný
  spôsob, ako "✓ jedným klikom" overiť cez skutočný prehliadač skôr, než
  #46 pristane).
- Nezávislý code-review subagent dispatchnutý PRED pushom (celý diff): 0 🔴
  0 🟡, dva 🔵 akceptované s odôvodnením (re-confirm bez varovania je
  ZÁMERNÉ — presne slúži "priebežne kontrolovať a opravovať" z popisu
  úlohy; `finalUrl === ""` obranná kontrola v `state.ts` je zámerne
  ponechaná pre budúce volania funkcie mimo dnešnej HTTP trasy). Verdikt:
  ready to merge.
- PR: **#54** (`dev` → `main`), `Closes #45`, merged `64c21ce`. CI all
  green (check, integration, e2e, docker-build, version-check) na push aj
  pull_request behu.
- Deployed + verified na https://forestshop-novy.newlevel.media
  (v0.3.0-dev.24, `/api/version` commit sedí s `64c21cef`): prihlásený ako
  skutočný vlastník (`vychod@varos.sk`, rola `admin`), obrazovka "Kontrola
  párovania" ukázala všetkých 14 110 reálnych produkčných variantov ako
  "Navrhnuté" (potvrdzuje LEFT JOIN dizajn na živých dátach — `pairing`
  tabuľka je dnes prázdna), "✓ Potvrdiť" správne disabled bez adresy.
  Funkčne overené: "✗ Zadať inú adresu" na reálnom variante
  ("0.8331.MC9") → zadaná testovacia adresa → "Potvrdiť" → riadok sa
  zmenil na "Potvrdené", stĺpec "Potvrdil" ukázal "Zbyněk (30. 7. 2026)"
  (skutočný prihlásený účet), adresa sa vykreslila ako klikateľný odkaz;
  konzola čistá (žiadna chyba nad rámec povolenej `/api/me` 401 pri
  prvom neprihlásenom načítaní). Testovací pairing riadok následne
  ODSTRÁNENÝ priamo v produkčnej DB (`DELETE FROM pairing WHERE
  variant_code = '0.8331.MC9'`), aby v produkcii nezostala fingovaná
  adresa vyzerajúca ako reálne potvrdené párovanie.

## Fixup review nálezov z PR #54 (bez GitHub issue — 2026-07-30)

- Bez trackovacieho issue (dispatch inštrukcia): tri review nálezy z PR #54
  (issue 45) — mŕtvy kód, skutočný defekt "krádež attribution" pri
  opätovnom potvrdení, chýbajúce `autocomplete`.
- **Skutočný defekt** (`state.ts`'s `confirmPairing()`): `onConflictDoUpdate`
  bezohľadne prepisoval `confirmedBy`/`confirmedAt` pri KAŽDOM volaní —
  druhý manažér kliknúci "✓ Potvrdiť" na už potvrdenom riadku ticho ukradol
  attribution bez toho, aby urobil nové rozhodnutie. Oprava: no-op
  re-potvrdenie (žiadny upsert, žiadny audit) presne keď je riadok už
  `potvrdene` A výsledná adresa je NEZMENENÁ; skutočná zmena adresy zostáva
  novým rozhodnutím (upsert + audit ako doteraz). Web strana: "✓ Potvrdiť"
  teraz aj disabled pri `state === "potvrdene"` (UX vrstva, server ostáva
  bránou).
- Mŕtvy kód (`finalUrl === ""` vetva) odstránený — jediný zapisovač
  `pairings.supplier_url` je táto istá funkcia, kŕmená len `null` alebo
  zod-overenou neprázdnou URL.
- RED→GREEN: `6e3f229` (red, nový integračný test v novom
  `pairing-reconfirm.integration.test.ts` zlyhá proti pôvodnému kódu) →
  `0562063` (green, oprava + mŕtvy kód). Nový súbor vznikol PRI red commite
  kvôli `max-lines` (400) ESLint pravidlu — `pairing-http.integration.test.ts`
  by inak prekročil limit; nie je to iná téma, len rozdelenie kvôli dĺžke.
- `autoComplete="current-password"`/`"new-password"` pridané do
  `ChangePasswordForm.tsx` (`43c4638`).
- PR: **#56** (`dev` → `main`), merged `ce4a3ab`. CI all green (check,
  integration, e2e, docker-build, version-check) na push aj pull_request
  behu; main push CI `version-check` bežal `skipped` (očakávané — main-push
  event, nie dev-vs-main porovnanie).
- Deployed + verified na https://forestshop-novy.newlevel.media
  (v0.3.0-dev.26, `/api/version` commit sedí s `ce4a3ab`). Produkcia mala v
  čase overovania 0 potvrdených pairing riadkov (`#46` auto-kandidáti ešte
  nepristali), takže disabled-stav "✓ Potvrdiť" na už potvrdenom riadku sa
  overil rovnakým testovacím vzorom ako pri PR #54: reálny variant
  `0.8331.MC9` → "✗ Zadať inú adresu" → testovacia adresa → "Potvrdiť" →
  overené `confirmDisabled: true`, `rejectDisabled: false`, stĺpec
  "Potvrdil" ukázal "Zbyněk (30. 7. 2026)"; konzola 0 chýb/0 varovaní
  (jediná VERBOSE hláška je nesúvisiaci Chrome hint o chýbajúcom
  username poli, nie o autocomplete). Testovací pairing riadok následne
  ODSTRÁNENÝ priamo v produkčnej DB (rovnaký `DELETE FROM pairing WHERE
  variant_code = '0.8331.MC9'` postup), variant overený späť v stave
  "Navrhnuté" bez adresy.
- Per-ticket Discord card fired (`notify --run-card`, confirmed delivered).
- Per-ticket Discord card fired (`notify --run-card`, confirmed delivered).

## Issue 57 — Ľavé menu (Systém/Sync zo Shoptetu, Eshop/Na objednanie) + vlastný vzhľad

- Resumed from a stopped worker's uncommitted tree (nav.ts registry,
  Sidebar/Topbar/SyncSection, className refactors) — kept the structure,
  replaced `app.css` entirely (it had literally copied the legacy app's CSS
  values, which the owner explicitly rejected), moved change-password from
  the sidebar footer to a user-menu dropdown in the Topbar header (owner's
  explicit instruction), fixed a missing `within` import in
  `SyncSection.test.tsx`.
- Design comment posted BEFORE first commit:
  https://github.com/zbynekdrlik/forestshop-app/issues/57#issuecomment-5131902935
- Fixed while finishing: `nav.spec.ts` wrongly asserted the orders screen is
  empty (e2e-setup.ts always seeds 2 real orders) + a login-rate-limit
  overflow on the shared e2e account (new isolated `e2e-nav@forestshop.sk`,
  same pattern as issue 47's `E2E_SKUPINY_EMAIL`).
- Commit `54b497b` (feature) on `dev`; PR **#68** (`dev` → `main`), merged
  `2683840`. CI all green (check, integration 184/184, e2e 14/14 ×2 stable
  runs, docker-build, version-check).
- Deployed + verified on https://forestshop-novy.newlevel.media
  (v0.3.0-dev.28, matches DOM). Sidebar shows exactly the two folders/tabs,
  Sync screen shows real catalog+orders sync status, "Na objednanie" shows
  real order data with the new design, user-menu reveals "Zmeniť
  heslo"/"Odhlásiť". Console: 0 errors/0 warnings.
- Playbook: new `.claude/rules/frontend-design.md` (design tokens, nav
  registry pattern, user-menu-in-header decision, e2e login-rate-limit
  gotcha) + CLAUDE.md router entry — commits `e0804cb`/`c0caca2` on `dev`
  (docs-only, rides the next feature PR; required its own version bump to
  `0.3.0-dev.29` after CI's version-check correctly caught the omission).
- Per-ticket Discord card fired (`notify --run-card`, confirmed delivered).

## Issue 67 — supplier link + supplier code from Shoptet export (2026-07-30)

- Verified on the real export (14 014 rows, read-only): `internalNote` is
  guid-consistent (0/4519 products had >1 distinct value) → product-level;
  `externalCode` genuinely differs between sizes of the same product (e.g.
  one product had `AJ26-L`/`AJ26-M`/`AJ26-S`/`AJ26-XL`) → variant-level.
- Design comment posted BEFORE first commit:
  https://github.com/zbynekdrlik/forestshop-app/issues/67#issuecomment-5132315183
- Migration `0011_medical_ronan.sql`: `product.internal_note` + `variant.external_code`
  (both nullable text). `map-row.ts`/`ingest.ts` capture both; new pure
  `modules/catalog/supplier-link.ts` (`extractSupplierLink`) extracts the URL
  out of a labelled note AT READ TIME (no extra derived column) — used by
  `orders/queries.ts` (OrdersSection) and `orders/mail.ts` (copied/mailed text,
  which already had the `[code, …].filter(Boolean).join(' | ')` mechanism
  prepared per `.claude/rules/orders.md`, just missing the data source).
- Tests: `supplier-link.test.ts` (unit, 8 cases covering the three real
  shapes + edges), `map-row.test.ts` (+4), `mail.test.ts` (+2 new format
  cases), `orders-http.integration.test.ts` (+1, all three shapes end to
  end), `supplier-mail.integration.test.ts` (+1), `OrdersSection.test.tsx`
  (+3), e2e `orders.spec.ts` assertion added against the real fixture link
  (huntingshop.eu, `4859/46`, `externalCode: OB832`).
- Commit `3564df2` (feature, single commit — greenfield feature, no bug-fix
  RED/GREEN needed) on `dev`; PR **#69** (`dev` → `main`), merged `a602cd7`.
  CI all green (version-check, check, integration 186/186, docker-build,
  e2e 14/14). Local: typecheck + lint + unit (400) + integration (186) +
  e2e (14) all green before push.
- Deployed + verified on https://forestshop-novy.newlevel.media
  (v0.3.0-dev.30, matches DOM). Triggered a live catalog re-import
  (14 066 variants, 4 533 products, 0 anomalies) so the new columns
  populated for real data, then confirmed real `huntingshop.eu` links +
  supplier codes (e.g. "OB041 / XHGOSH") render on real "Na objednanie"
  rows, clickable, correct `href`. Console: 0 errors/0 warnings.
- Per-ticket Discord card fired (`notify --run-card`, confirmed delivered).

## Issue 70 — code-review follow-up on PR 69 (2026-07-30)

- Two independent post-merge reviews of PR 69 (issue 67, merge `a602cd7`)
  found 9 real defects in that diff. Filed as issue **#70** (`Scope-gate:
  planned-work`), design comment posted before first code commit.
- 1) `extractSupplierLink`'s `URL_RE`'s greedy `\S+` swallowed trailing
  punctuation (`.`, `)`) right after the URL — trimmed with a
  `TRAILING_PUNCTUATION_RE` post-match replace. RED/GREEN:
  `supplier-link.test.ts` (3 new cases) → `supplier-link.ts`.
- 2) `OrdersSection.tsx`'s `—` placeholder ignored `externalCode` — now
  shown only when `supplierUrl`, `supplierNote` AND `externalCode` are all
  null. RED/GREEN: `OrdersSection.test.tsx` → `OrdersSection.tsx` (also
  bundled 4/8 below, same lines).
- 3) `.ord-supplier-cell`'s unbounded `nowrap` bounded with
  `overflow/text-overflow/ellipsis`, matching `.folder-head .ftitle`'s
  existing pattern; `title` attr added for the full text (CSS-only, no
  unit-testable behavior — manually verified live).
- 4) `rel="noopener"` added alongside `noreferrer`.
- 5) `ordersApi.ts`'s `supplierUrl` zod schema now regex-checks
  `^https?:\/\//` as an independent second layer. RED/GREEN:
  `ordersApi.test.ts` → `ordersApi.ts`.
- 6) `getOrderDetail`/`OrderDetailLine` (`queries.ts`) extended with the
  three fields — third read path unified with `listOpenOrderLinesBySupplier`
  / `mail.ts`. RED/GREEN: `orders-http.integration.test.ts` →
  `queries.ts`.
- 7) Multi-URL-in-one-note case added to `supplier-link.test.ts` (first-match
  is intentional, now documented + tested).
- 8) `aria-label` on the supplier link now carries the product name
  (distinct accessible name per row) — bundled with fix 2/4.
- 9) 128-char line in `ingest.ts` wrapped.
- Side-effect: the new order-detail test pushed
  `orders-http.integration.test.ts` over eslint's 400-line cap — split
  state-change (#25) tests into a new `orders-http-state.integration
  .test.ts`, same pattern as the existing `catalog-http`/
  `catalog-http-ingest` split. See `.claude/rules/testing.md`.
- Deliberately NOT fixed (documented in PR body): the " | " ambiguity in
  copied order text — human-read only, never re-parsed.
- Commits (12, `dev`): version bump 0.3.0-dev.32, 4 RED/GREEN pairs (1, 2,
  5, 6), 2 pure fixes (3+4+8 bundled into fix 2's commit, 9 standalone),
  the eslint-line-cap split. PR **#71** (`dev` → `main`), merged `6f97afd`.
  CI all green both on the PR and on `main` (version-check, check,
  integration 187/187, docker-build, e2e 14/14; Deploy workflow green).
  Local: typecheck + lint + unit (405) + integration (187) + e2e (14) all
  green before push.
- Deployed + verified on https://forestshop-novy.newlevel.media
  (v0.3.0-dev.32, commit matches `git log origin/main -1`). Live-checked
  against real production order data (864 supplier cells): 0 cells show
  the `—` placeholder alongside a supplier code, `rel="noreferrer
  noopener"` + product-name `aria-label` present on every link, supplier
  notes truncate with `title` + ellipsis CSS applied. Console: 0
  errors/0 warnings.
- Per-ticket Discord card fired (`notify --run-card`, confirmed delivered).

## Issue 72 — residual defects after issue 70/PR 71 (2026-07-30)

- Two residual defects, both proven live by executing the shipped code before
  fixing: 1) `extractSupplierLink`'s trailing-punctuation trimmer stripped
  ANY trailing closing bracket, even one that is part of the URL itself
  (`https://shop.example.com/a_(b)` → truncated to `.../a_(b`, dead link).
  2) `OrdersSection.tsx`'s supplier-link `aria-label` only carried
  `variantName`, so two order lines of the same product in different sizes
  had an identical accessible name. Filed as **#72** (`Scope-gate:
  planned-work`), design comment posted before first code commit.
- Fix 1: `trimTrailingPunctuation()` replaces the blind regex — non-bracket
  trailing punctuation still stripped unconditionally, a trailing closing
  bracket stripped ONLY when unbalanced within the candidate URL (more
  closers than openers of that type), iterated for mixed suffixes (`(b).`).
  RED/GREEN: `supplier-link.test.ts` (commit `b6cc565` RED → `290e0d3`
  GREEN), later extended (code-review 🔵 findings) with a third bracket
  type (`{}`) and an unclosed-opening-bracket case (commit `fdf7fe2`).
- Fix 2: `aria-label` now interpolates `variantCode` alongside `variantName`.
  RED/GREEN: `OrdersSection.test.tsx` (same commits) — existing test's
  exact-match name updated + a new dedicated two-different-sizes test.
- Side-effect discovered while driving PR 73's CI green (not part of the
  original scope, fixed in the same PR since it blocked merge): `orders
  .spec.ts`'s state-change e2e test asserted `toContainText("Skladom")`,
  which is tautological — ALL FOUR `STATE_LABELS` are always rendered as
  `<option>` children of the `<select>` regardless of selection, so the
  assertion never waited for the state-change PATCH to actually resolve.
  Under CI's slower runner `page.reload()` occasionally raced ahead of the
  still-in-flight write (observed once, PR 73's first CI run). Fixed by
  asserting `toHaveValue("skladom")` directly on the select — this
  genuinely waits for the local optimistic update, which only fires after
  the PATCH promise resolves. Commit `8fe21cd`.
- Commits (5, `dev`): version bump 0.3.0-dev.34, RED test commit, GREEN fix
  commit, e2e-flake fix commit, code-review-followup test commit. PR **#73**
  (`dev` → `main`), merged `edb2b8e`. CI all green on the PR (check,
  integration, e2e 14/14, docker-build, version-check) and on `main`
  (check, integration, e2e, docker-build). Local: typecheck + lint +
  unit (257 API + 155 web) + full e2e suite (14/14, 0 console errors)
  all green before push.
- Deep code review (`requesting-code-review`) found 0 🔴 0 🟡, 4 🔵 — 3
  addressed (missing `{}` bracket test, missing unclosed-opening test, a
  documentation comment on the count-based-not-stack-based balance check
  limitation), 1 explicitly pre-existing/out-of-scope (an all-punctuation
  candidate trims to bare `https://` — same failure mode existed before
  this PR, unrelated to issue 72).
- Deployed + verified on https://forestshop-novy.newlevel.media
  (v0.3.0-dev.34, `/api/version` commit + DOM version label both match
  `edb2b8e` = `origin/main` HEAD). Live-checked "Na objednanie": supplier
  links render with `aria-label` now carrying `variantCode` (e.g. "Odkaz na
  dodávateľa — Poľovnícke kraťasy HART GOROSTA-SH (62621/52)"). Console:
  0 errors/0 warnings.
- Per-ticket Discord card fired (`notify --run-card`, confirmed delivered).

## 2026-07-30 — #59 (Na objednanie: filter podľa stavu objednávky zo Shoptetu)

- Validated live first: DB schema on dev2 had NO status column at all
  (`\d "order"`), and the live "Na objednanie" showed all 864 lines
  unfiltered — issue confirmed still real.
- Design comment posted BEFORE any code:
  https://github.com/zbynekdrlik/forestshop-app/issues/59#issuecomment-5133725274
  (2026-07-30T16:46:09Z, before first code commit `40c823f`).
- Commits (5, `dev`): version bump 0.3.0-dev.35; `feat` — capture
  `order.status_name` at ingest (migration `0012`, `parser.ts`/`ingest.ts`,
  own tests) `40c823f`; RED — failing integration test proving the
  unfiltered list `54252fd`; GREEN — `queries.ts` filter by
  `order_open_status` `24fa075`; `feat` — admin settings panel +
  `GET/PUT /api/orders/open-statuses` + e2e `0a8e467`. PR **#74** (`dev` →
  `main`), merged `5adb8c3a`.
- Deliberately did NOT copy the legacy app's 4-set model
  (`to_order`/`terminal`/`known_open`/`cancelled` + impact-preview dialog)
  — this app has neither "Nedostupné" nor reminder e-mails, so those three
  sets would be dead complexity (MVP). Single `order_open_status` list,
  seeded with the legacy default ("Vybavuje sa") so nothing silently
  changes on deploy.
- Two real bugs found + fixed during this ticket, both worth remembering:
  1. **Route registration order matters in Hono** — `GET/PUT
     /api/orders/open-statuses` registered AFTER the parameterized `GET
     /api/orders/:id` meant Hono matched "open-statuses" as `:id` first and
     404/400'd on invalid UUID before the intended handler ever ran. Fix:
     register literal-path routes BEFORE parameterized siblings on the same
     prefix. Caught by the local e2e run, not by any unit/integration test
     (those call the module functions directly, never through the full
     route table) — worth remembering for the next literal-vs-`:param`
     route added under an existing `:id` prefix.
  2. **`order_open_status` is a new ROOT table `TRUNCATE ... CASCADE` never
     reaches** (same class as `supplier_contact`/`supplier`, no FK either
     direction) — `tests/helpers/db.ts` and `scripts/e2e-setup.ts` both
     needed it added to their TRUNCATE list AND a re-seed of the default
     row after, or the table would either leak mutations across tests or
     start every test from a silently-empty (nothing-ever-shows) state.
     `DEFAULT_ORDER_OPEN_STATUS` exported from `open-statuses.ts` so both
     helpers and the migration's seed value stay tied together.
  3. `buildCsv` test helper in `orders-ingest.integration.test.ts` encodes
     UTF-8 while `ingestOrders` always decodes as windows-1250 (matching
     the real Shoptet export) — a non-ASCII literal in a hand-built test
     CSV row mojibakes. Hand-built CSV tests in that file must stay
     ASCII-only; real diacritics are covered by the committed cp1250
     fixture instead.
- CI green on the PR (check, integration, e2e, docker-build,
  version-check) and on `main`. Local: typecheck + lint + unit (263 API +
  167 web) + integration (193) + full e2e (15/15) all green before push.
- Deployed + verified on https://forestshop-novy.newlevel.media
  (v0.3.0-dev.35, commit `5adb8c3a` matches `/api/version` and the DOM
  label). Triggered a real "Stiahnuť teraz" re-import on production to
  populate real statuses on existing orders (they carried the migration's
  DB-default status until the next re-import) — "Na objednanie" dropped
  from 864 unfiltered lines to 39 correctly-filtered lines. Settings panel
  read back the real distinct statuses Shoptet uses (Kompletná, Nevybavená,
  Osob. odber, Stornovaná, Vratený tovar, Vybavená, Vybavená výmena,
  Vybavený Dobropis, Vybavuje sa) — no typo-guessing needed. Console: 0
  errors/0 warnings throughout.
- Per-ticket Discord card fired (`notify --run-card`, confirmed delivered).

## 2026-07-30 — issue 60 (na objednanie: odškrtnutie objednaného + hromadné označenie skupiny)

- Design comment posted before first commit: https://github.com/zbynekdrlik/forestshop-app/issues/60#issuecomment-5134292105
  (root cause: `state` enum's `objednane` value is the row's DEFAULT/pending
  state, not a confirmation of ordering — three different UI spots used the
  word "Objednané" with three different meanings; chosen approach: a new
  independent `order_line.ordered` boolean, orthogonal to `state`, mirroring
  the legacy app's separate `ORDERED` flag; rejected: folding it into the
  existing `state` enum).
- Version bump `fdcc30e` (0.3.0-dev.35 → .36). Backend `d394504`: migration
  0013 (`order_line.ordered boolean default false`), `setOrderLineOrdered`/
  `setSupplierLinesOrdered` in `modules/orders/state.ts`,
  `listOpenOrderLineIdsForSupplier` in `queries.ts`,
  `POST /api/orders/lines/:lineId/ordered` + `PUT /api/suppliers/:supplier/
  order-lines/ordered`, new integration test file
  `orders-http-ordered.integration.test.ts` (8 tests). Frontend `add3164`:
  checkbox column + per-supplier bulk toggle button (label flips between
  "✔ Označiť skupinu ako objednané" / "↺ Zrušiť označenie skupiny", legacy
  `markGroupOrdered` UX minus its `commitSeq` concurrency machinery — MVP,
  single/few concurrent managers); renamed the two colliding "Objednané"
  labels (`STATE_LABELS.objednane` → "Nevybavené", date column → "Dátum
  objednávky"); extracted `OrderLineRow.tsx` to stay under eslint's
  `max-lines: 400` (`OrdersSection.tsx` hit 454). No RED/GREEN — greenfield
  feature (implement-then-test, per `tdd-workflow.md`), not a bug fix.
- Fix commit `c801810`: the new `orders.spec.ts` e2e test used
  `checkbox.check()`, which raced the async POST on GitHub Actions (passed
  locally, failed on the PR-triggered CI run) — switched to `.click()` +
  `expect(...).toBeChecked()`, same principle already documented for
  `<select>` in `.claude/rules/testing.md`.
- CI green (check/integration/e2e/docker-build/version-check) on `dev` push,
  on the PR (`#75`), and on `main` after merge (`42153ac9`). Local before
  push: typecheck + lint + unit (263 API + 175 web) + integration (201) +
  full e2e (16/16, including 3 repeated fresh runs) all green.
- Deployed + verified on https://forestshop-novy.newlevel.media
  (v0.3.0-dev.36, commit `42153ac9` matches `/api/version`). Manually
  exercised on a REAL production order line + a real 7-line supplier group
  (BETALOV): checkbox check/uncheck persisted across reload and dimmed the
  row; bulk button marked all 7 lines and flipped its own label, then
  unmarked them again — both directions verified, prod data restored to its
  original (unchecked) state afterward. 0 console errors/warnings.
- Playbook updated: `.claude/rules/testing.md` (Playwright `.check()` vs
  `.click()` race on a controlled checkbox with async `onChange`),
  `.claude/rules/orders.md` (`ordered` boolean is independent of `state`,
  never fold future "already handled" needs into the `state` enum),
  `.claude/rules/frontend-design.md` (component-file max-lines split
  pattern — extract the repeated row/item renderer first).
- Per-ticket Discord card fired (`notify --run-card`, confirmed delivered).

## 2026-07-30 — review of PR 76 (five findings, no GitHub issue — direct review-fix cycle)

- Not a GitHub-issue-tracked ticket: user handed five code-review findings
  from an independent review of PR 76's own diff directly, to fix in one PR
  (`explicitly: do NOT file a GitHub issue for them`). Version bump `225b113`
  (`0.3.0-dev.38`).
- **Finding 1** (deadlock risk): `queries.ts`'s
  `listOpenOrderLineIdsForSupplier`'s `.for("update")` had no `of` list,
  locking `variant`/`product` too — opposite lock order vs.
  `catalog/ingest.ts`'s product→variant. RED `b18dbfa` (new test
  `"hromadné označenie NEČAKÁ na zámok katalógovej tabuľky (product)…"`,
  confirmed hangs to the 30s `testTimeout` against the unfixed query — see
  report) → GREEN `bbc92bf` (`.for("update", { of: [orderLines, orders] })`).
- **Findings 2/3/4** (test-quality only, same file, RED-only commit
  `b18dbfa` since no production code changed): replaced the existing lock
  test's fixed 200ms sleep with `pg_stat_activity` polling (deterministic
  "still blocked" proof), removed a tautological `expect(settled).toBe(true)`
  right after `await bulk` (a `.then()` registered earlier always resolves
  first), added a rejection handler to that same `.then()`.
- **Finding 5** (UI busy-guard mirror): `OrdersSection.tsx`'s group toggle
  button was disabled only for its own bulk write (`busyOrderedSupplier`),
  not for a per-row write in flight for a line in that group
  (`busyOrderedLineId`) — the reverse of PR 75's finding 6. RED `a8718f6`
  (new test `"skupinové tlačidlo je disabled počas per-riadkovej zmeny…"`,
  confirmed fails against unfixed component) → GREEN `ca550d6` (added the
  mirror condition to `disabled`).
- Deep-review subagent (`superpowers:requesting-code-review`) came back
  0 🔴 0 🟡, 2 🔵 (both same-file touch-ups, not new scope) → fixed in
  `93acfb5`: corrected a stale docblock comment in `queries.ts` that still
  described the pre-finding-1 unscoped lock, and added `backend_type =
  'client backend'` to the `pg_stat_activity` poll to rule out a
  theoretical autovacuum false positive.
- Docs commits `6f2f7f8` (`.claude/rules/database.md` — rewrote the
  `FOR UPDATE` note to cover findings 1-4 together, replacing the
  now-incomplete PR-75-only version) and `c08a1db`
  (`.claude/rules/frontend-design.md` — bidirectional busy-guard gotcha,
  same pattern needed a fix in both directions across PR 75 + PR 76).
- CI green (check/integration/e2e/docker-build/version-check) on `dev`
  push, on the PR (`#77`), and on `main` after merge (`d19f8eae`). Local
  before push: lint + typecheck clean, unit 263 API + 177 web, integration
  207 (Postgres 5433).
- **Deploy hit an unrelated infra race**: `docker compose up -d` on dev2
  failed (`No such container: 4403a25ef63f_forestshop-app-1`) because the
  OLD `0.3.0-dev.37` container did not exit on `SIGTERM` within the 10s
  stop grace period and got `SIGKILL`ed mid-recreate, leaving prod down
  (502) with `forestshop-app-1` fully removed. Recovered manually
  (`docker compose -f docker-compose.prod.yml up -d` on dev2) — confirmed
  `/api/version` back to `0.3.0-dev.38`/`d19f8eae`, clean logs. Filed as a
  separate issue (`#78`, scope-gate `cross-cutting`) rather than fixed here
  — `apps/api/src/index.ts` has no `SIGTERM`/`SIGINT` handler at all, root
  cause needs its own investigation + design (touches both the app's
  shutdown path and `docker-compose.prod.yml`), out of scope for these five
  findings.
- Deployed + verified on https://forestshop-novy.newlevel.media
  (v0.3.0-dev.38, commit `d19f8eae` matches `/api/version`). Playwright on
  the live "Na objednanie" screen: single checkbox (order 20261263,
  variant 62605/6) ticked, reload confirmed it stayed ticked + row dimmed;
  supplier group "Citrade" (2 lines) group-toggled to ordered (label
  flipped to "↺ Zrušiť označenie skupiny"), then toggled back to unordered
  (label back to "✔ Označiť skupinu ako objednané") — both directions
  confirmed via DOM read. Reload afterward: all 39 checkboxes on the page
  unchecked (data restored). 0 console errors/warnings across the whole
  session.
- No PR number appears in any commit message (`#N` bans the design-comment
  hook on this repo) — "PR 76"/"PR 77" written in prose throughout.
- Shared PR: `#77`.

## 2026-07-30 — issue 78 (deploy SIGTERM/recreate race)

- Root cause: `apps/api/src/index.ts` had NO signal handler at all. The
  container runs as PID 1 (`Dockerfile`'s `CMD`, no `tini`/`init: true`), and
  the kernel does not apply a signal's default disposition to PID 1 unless
  the process installs an explicit handler — so SIGTERM was silently
  ignored for the full `stop_grace_period` (10s) until Docker SIGKILLed the
  process, racing `docker compose up`'s Recreate step ("No such container").
  Same symptom had already hit deploy for PR 25 and was misdiagnosed there
  as transient containerd flakiness (fixed by a rerun) — corrected that
  playbook entry in place (`.claude/rules/deploy.md`) rather than leaving
  the wrong lesson for the next occurrence.
- New `apps/api/src/shutdown.ts`: `createShutdownHandler()` — idempotent,
  stops the scheduler (`.stop()`, so no new tick starts mid-shutdown),
  proactively closes idle HTTP connections, closes the HTTP server then the
  DB pool, `process.exit(0)`; bounded 8s force-exit(1) fallback, guarded
  against a double `exit()` call. `docker-compose.prod.yml`'s `app` service
  got an explicit `stop_grace_period: 15s` as a complementary margin.
- RED/GREEN: `bf7f593` (test, `[red]`, confirmed failing — module didn't
  exist yet) → `a022b27` (fix, `[green]`). Three follow-up commits from
  self-review + an independent code-review subagent: `8059324` (double-exit
  guard), `ceaf2b4` (stop_grace_period + playbook correction — landed
  between red/green and the follow-ups), `c18f23b` (scheduler stop +
  closeIdleConnections + a fourth test proving an in-flight request
  completes normally when the signal arrives mid-request — this test
  surfaced a real subtlety: `server.close()` waits on Node's
  `keepAliveTimeout` unless the response sets `Connection: close`).
- Verified end-to-end THREE times against the actual built production
  Docker image running as real PID 1 (not just the integration test): a
  bare `docker stop -t 15` on the unfixed image would have hung the full
  grace period; on the fixed image it exited in 431ms, then 211ms after the
  scheduler-stop wiring, both with exit code 0.
- CI green (check/integration ×211/e2e/docker-build/version-check) on `dev`
  push and on the PR (`#79`) across all three pushes; local before each
  push: lint + typecheck clean.
- Shared PR: `#79`.

## Issue 61 — Na objednanie: supplier filters, remaining summary, hide-resolved toggle

- Design comment posted on issue 61 before any code (root cause: no
  filter/summary/toggle existed on "Na objednanie"; chosen approach: pure
  client-side filter over the already-fully-loaded `/api/orders/open`
  data, `isLineResolved = ordered || state !== "objednane"` as the direct
  translation of the legacy app's `isHandled`; rejected alternative:
  breakdown by `state` alone, which would silently drop `ordered=true`
  lines still in the default state).
- New pure logic module `apps/web/src/ordersSummary.ts`
  (`isLineResolved`/`summarizeOrderLines`/`formatOrderSummaryText`, unit
  tested in `ordersSummary.test.ts`) + `OrdersToolbar.tsx` (chips/summary/
  toggle, unit tested) + `SupplierActionsPanel.tsx` (mechanical extraction
  from `OrdersSection.tsx`, no behavior change — the file was already at
  eslint's `max-lines: 400` cap before this feature).
- Hide-resolved toggle persists via `localStorage`
  (`forestshop.orders.hideResolved`); supplier-chip selection is
  deliberately NOT persisted (issue only asked persistence for the
  toggle). Group-level bulk actions (email, bulk "objednané", mail
  preview/send) keep operating on the FULL unfiltered `group.lines` —
  only the rendered table rows respect `hideResolved`.
- New isolated e2e account (`e2e-filtre@forestshop.sk`) + a new
  `orders.spec.ts` test placed FIRST in the file (not last, unlike the
  other isolated-account tests) so it observes the pristine seeded data
  before later tests in the same file mutate state/`ordered`/
  `order_open_status` — see `.claude/rules/testing.md`.
- Commits: `f27510e` (version bump 0.3.0-dev.40) → `98d767e`
  (SupplierActionsPanel extraction) → `a4f1724` (feature + tests).
- Verified live on `https://forestshop-novy.newlevel.media/?tab=orders`
  against real production data (39 lines / 17 supplier groups): chips
  narrow correctly, summary recomputes per active filter, hide-resolved
  toggle hides a fully-resolved supplier and survives a reload — then the
  test mutation (one line's "objednané" checkbox) was reverted, restoring
  the data to its original state. Zero console errors/warnings throughout.
- CI green (check/integration/e2e/docker-build/version-check) on `dev`
  push and PR `#80`; main CI + Deploy green on merge `ed2b153`; live
  `/api/version` matched (`0.3.0-dev.40` @ `ed2b153`).
- Shared PR: `#80`.

## Issue 62 — súčet kusov toho istého produktu naprieč objednávkami dodávateľa

- Root cause / design comment posted to issue 62 BEFORE the first feature
  commit: legacy `app.js:1918-1962`'s `groupQtyTotals`/`totalChipSpec`
  (per-supplier chip, ≥2 lines of the same `itemCode`, "remaining" text +
  "total" tooltip) ported as a DERIVED value computed on every render
  (`ordersSummary.ts`'s `computeVariantTotals`/`formatVariantTotalChip`) —
  rejected the legacy's imperative DOM-patch approach (`refreshOrderTotals`)
  since this app has no non-React editor state that a repaint would disturb.
- New chip class `.qty-total-chip` in `OrderLineRow.tsx`'s qty cell,
  intentionally non-clickable/visually distinct from the filter `.chip`
  (issue 61). Computed over the group's FULL (unfiltered) `group.lines`, so
  it never depends on the "skryť vybavené" toggle.
- E2E fixture needed a genuinely-repeating product WITHOUT touching
  `DODAVATEL-TEST-1`/`(bez dodávateľa)` (other tests assert their EXACT
  line counts, e.g. "Všetci (2)") — added a brand-new supplier
  `DODAVATEL-TEST-2` by changing ONE previously-unused-in-tests CSV fixture
  row's `supplier` field (`60055/10`, was empty) and two new orders in
  `scripts/e2e-setup.ts` referencing it twice (3 ks + 2 ks). CSV edit done
  byte-for-byte via a Python round-trip script (file is cp1250, quoted data
  rows but an UNQUOTED header row — `csv.QUOTE_ALL` on the whole file would
  have silently re-quoted the header too). New isolated e2e account
  `e2e-sucet@forestshop.sk` (shared account already at `MAX_ATTEMPTS=10`).
  Updated the ONE existing global-count assertion in `orders.spec.ts`
  ("Všetci (2)"/"Ostáva vybaviť 1 z 2 · Čaká sa 1" → "(4)"/"3 z 4 · Čaká sa 1").
- Commits: `c8805d0` (version bump 0.3.0-dev.42) → `a3cf6d6` (feature + tests).
- Verified live on production (39 real order lines, 0 naturally-repeating
  `variantCode` right now) — confirmed the ABSENCE of any chip is correct
  (no false positive), then toggled one real row's "ordered" checkbox and
  back via Playwright: write persisted instantly (no reload), console
  stayed at 0 errors/0 warnings, all 39 rows confirmed back to unchecked
  afterwards. The actual sum/live-recompute-on-repeat behavior is proven by
  the new CI-green `orders.spec.ts` test (controlled `DODAVATEL-TEST-2`
  fixture), since live data has no natural repeat at verification time.
- CI green (version-check/check/integration/e2e/docker-build) on `dev` push
  and PR `#82`; main CI + Deploy green on merge `04435a5`; live
  `/api/version` matched (`0.3.0-dev.42` @ `04435a5`).
- Shared PR: `#82`.

## Issue 63 — Na objednanie: ručné priradenie dodávateľa k riadku bez dodávateľa

- Design comment posted BEFORE any code (root cause: `product.supplier`
  is the only source of truth for grouping and is `null` exactly when
  Shoptet doesn't carry it — nothing survives a nightly catalog
  re-import, and grouping was exact-string, not case/whitespace
  tolerant). Verified live against production DB first: exactly 3 open
  order lines with no supplier (matching the ticket), plus real
  case-duplicate supplier names already in the catalog
  (`HUNTING24`/`Hunting24`, `Werra`/`WERRA`, `L.A. Team`/`L.A. TEAM`).
- New `product_supplier_override` table (migration 0014), keyed by
  `product_key` (not variant) so one assignment applies to every sibling
  size. Effective supplier everywhere is `coalesce(product.supplier,
  override.supplier)` (`modules/orders/supplier-key.ts`'s
  `effectiveSupplierSql`) — a fallback, never a permanent pin: a later
  real Shoptet value wins. Case/whitespace-insensitive grouping
  (`normalizedSupplierKeySql`/`normalizeSupplierKeyJs`) applied on ALL
  THREE read paths that group/filter by supplier
  (`listOpenOrderLinesBySupplier`, `listOpenOrderLineIdsForSupplier` —
  bulk "ordered" toggle, and `mail.ts`'s `loadOutstandingLines`) — missing
  any one of the three would silently under-reach a merged group.
  Canonical display spelling on a merge: most-frequent raw spelling
  (`pickCanonicalSupplierSpelling`), tie-broken alphabetically.
- New `POST /api/orders/lines/:lineId/supplier` (assignOrderLineSupplier)
  upserts the override for the line's product. Frontend: inline text
  input + shared `<datalist id="known-suppliers">` (built from the
  already-loaded `/api/orders/open` groups, no new GET route) on any line
  where `supplierAssignable` (i.e. `product.supplier === null`). Save
  triggers a full refetch (line changes GROUP, same reasoning as
  `PairingSection`'s refetch-after-confirm). Extracted
  `SupplierOrderGroup.tsx` from `OrdersSection.tsx` (same mechanical
  reason as the earlier `OrderLineRow`/`SupplierActionsPanel`
  extractions — no line-count headroom left for the new state/callback).
- Two real bugs found and fixed during implementation (both documented in
  `.claude/rules/database.md`/`testing.md`): (1) `\s` inside a drizzle
  `sql` JS template literal silently loses its backslash (JS doesn't
  recognize `\s` as an escape, so the SQL text sent to Postgres was
  `'s+'`, not `'\s+'`) — fixed with `\\s+`, caught via `.toSQL()` +
  direct DB probing, not by inspection. (2) `insertTestVariantForProduct`
  test helper's `options.supplier ?? "Test dodávateľ"` silently ignored
  an explicitly-passed `null` (no prior test needed a shared-product
  fixture with no supplier) — fixed to `"supplier" in options ? ... :
  ...`. (3) The new `.ord-supplier-assign` table cell's input+button
  visually overflowed into the neighbouring "Stav" column under
  `white-space: nowrap`, whose `<select>` (later in the DOM) then stole
  Playwright clicks meant for the save button — fixed with `display:
  flex; flex-wrap: wrap` instead of `nowrap`.
- Small fold-in fix from a comment on the same ticket:
  `formatVariantTotalChip` (issue 62) now also hides the chip when
  `remaining === 0`, not just `lineCount < 2` — own unit test.
- Tests: unit (`supplier-key.test.ts` — normalization + canonical-spelling
  picking, `ordersSummary.test.ts` — chip hide), integration
  (`orders-supplier-assignment.integration.test.ts` — persistence,
  propagation to a sibling size, case/whitespace merge reaching a bulk
  action AND the mail aggregation, 403/404/400), e2e (new fixture: order
  9006, variants `60035/L`/`60035/M` — two sizes of the same product,
  both with no supplier in the CSV fixture — new isolated
  `e2e-priradenie@forestshop.sk` account, positioned LAST in
  `orders.spec.ts` since it permanently moves those lines out of
  "(bez dodávateľa)"). Updated the file's pre-existing exact-count/text
  assertions the new global fixture lines shifted (first test's chip
  counts + summary, the mail-preview test's aggregated item count/body,
  a row locator that became ambiguous once "(bez dodávateľa)" grew past
  1 line), plus `exact: true` on an existing "Uložiť" button locator that
  started colliding (substring match) with the new per-line save
  button's aria-label.
- Verified live on production (`https://forestshop-novy.newlevel.media`):
  assigned a real no-supplier line (`20261228 / 40258/XL`) to a
  throwaway test supplier via Playwright — row moved groups immediately
  ("(bez dodávateľa)" 3→2, new group appeared, "Všetci" stayed 39),
  survived a reload, console stayed at 0 errors/0 warnings throughout.
  Deleted the test override row directly in `product_supplier_override`
  afterward and reloaded — line returned to "(bez dodávateľa) (3)"
  exactly; production data confirmed restored (39 open lines, 0 marked
  ordered).
- Commits: `6fcc039` (version bump 0.3.0-dev.44) → `8a9e18c` (migration)
  → `ead8ae3` (backend) → `b2a006d` (frontend) → `2b5b0e2` (chip fix) →
  `ec9bd8d` (e2e).
- CI green (version-check/check/integration/e2e/docker-build) on `dev`
  push and PR `#84`; main CI + Deploy green on merge `3e66505`; live
  `/api/version` matched (`0.3.0-dev.44` @ `3e66505`).
- Shared PR: `#84`.

## Issue 89: PR 87 review findings (409 refetch, log, playbook, unit test)

- Four small hardening findings from an independent code review of PR 87
  (issue 86): (1) `OrdersSection.tsx`'s `assignSupplier` refetched only on
  success — added `load()` to the `.catch()` too, RED (`OrdersSection
  .assignSupplier.test.tsx`) before GREEN, so a rejected assignment (e.g.
  the 409) no longer leaves the list stale forever; (2) `orders-routes.ts`
  returned before `log.info` on the `already_has_supplier` 409 branch —
  added `log.warn` with actorUserId/lineId/supplier, test spies on the real
  pino `log.warn`; (3) `.claude/rules/orders.md` records the tension
  between this 409 and `testing.md`'s no-4xx-for-Playwright-exercised-
  domain-failures rule, deliberately not changed to 200 (no e2e exercises
  this banner yet); (4) `ordersApi.test.ts` had zero coverage of
  `assignOrderLineSupplier` — added 3 tests (POST shape, 409 Slovak
  message surfacing, 401 mapping). Fifth review finding (a cleanup
  migration for dormant `product_supplier_override` rows) skipped —
  production table verified empty (0 rows).
- Design writeup posted to issue 89 BEFORE the first commit (root cause +
  approach + rejected alternative per finding).
- Commits: `833af25` (bump 0.3.0-dev.48) → `64cd4ee` (RED, finding 1) →
  `de7034c` (GREEN, finding 1) → `58b705e` (finding 2 + test) → `e41237a`
  (finding 4) → `4b3bd81` (finding 3, playbook).
- CI green on `dev` push + PR `#90`; merged to main (`0f60247`) — but
  main's `check` job then FAILED once (flaked), see follow-up below.
- **Follow-up discovered during verification**: the new
  `OrdersSection.assignSupplier.test.tsx` test flaked on main's CI
  (~1-in-150 reproduced locally). Root cause: `OrderLineRow.tsx`'s
  `useEffect` resetting the supplier-draft from `manualSupplierOverride`
  ran on every MOUNT too (not just on a genuine later change — `useEffect`
  always fires once after first commit regardless of whether the
  dependency "actually changed"), which could race with an interaction
  immediately after a row appears and silently wipe a just-typed value.
  Fixed with a `useRef` mount-skip guard in `OrderLineRow.tsx`; verified
  with a 300-iteration stress loop (0 failures after, several before).
  Finding + fix recorded on issue 89 (already closed by PR 90's merge).
  Commits: `dd45e1c` (bump 0.3.0-dev.49) → `fc53463` (mount-race fix).
  CI green on `dev` push + PR `#91`; merged to main (`0c3ae7f`); main CI +
  Deploy green on their own (no retries); live `/api/version` matched
  (`0.3.0-dev.49` @ `0c3ae7f`).
- Live verification (`https://forestshop-novy.newlevel.media`): baseline
  confirmed before AND after (v0.3.0-dev.49, "Všetci (39)", "BETALOV (7)",
  "(bez dodávateľa) (3)", "Ostáva vybaviť 39 z 39", `product_supplier
  _override` 0 rows) — assigned a throwaway supplier to line `20261263 /
  40690/122`, watched it move groups (3→2, "Všetci" stayed 39, new group
  appeared), deleted the resulting override row directly in the DB,
  reloaded and confirmed exact restoration. Console: 0 errors/0 warnings
  throughout, including on the final reload.
- Shared PRs: `#90` (four findings), `#91` (follow-up race fix).

## Issue 65 — order remark, Shoptet admin link, stale-order badge

- Design comment (root cause + approach + rejected alternative per
  sub-point, posted BEFORE any code):
  https://github.com/zbynekdrlik/forestshop-app/issues/65#issuecomment-5142632080
- Item 4 (order date) was already implemented before this ticket — no
  code change, just confirmed in the design comment.
- Item 1 (customer remark): resolved a genuine conflict between the
  ticket's title (echoes the legacy app's "Poznámka e-shopu" label, which
  IS `shopRemark`) and its own body text ("čo napísal zákazník" — which is
  `remark`). Verified on real cached export data
  (`parovanie_produktov/data/out/orders_cache.csv`) which field is which;
  the ticket's explicit body text won. New `order.remark` column
  (migration `0015_wealthy_spectrum.sql`), refreshed on re-import (always
  Shoptet-owned, same family as `status_name`).
- Item 2 (admin link): the ticket cited `app.js:2253-2260` (`?code=` on
  `objednavky-detail/`) — but a NEWER, live-verified finding in the same
  sibling repo (`posta_uncollected.py`/`orders_reminder.py`, 2026-07-22)
  proves that pattern is silently ignored by Shoptet's admin. Used the
  verified working pattern (`/admin/vyhladavanie/?string=<code>&src=orders`)
  instead. New non-secret `SHOPTET_ADMIN_BASE_URL` env var.
- Item 3 (stale badge): reused `isLineResolved`, mirrored the legacy
  app's `orderAgeDays`/`STALE_ORDER_DAYS=14` behavior. Boundary tested
  explicitly (14 days → no badge, 15 days → badge) in
  `ordersSummary.test.ts`.
- Commits: `80ca2af` (bump 0.3.0-dev.53) → `71f296b` (remark + admin link,
  backend) → `d13c65a` (stale-badge logic) → `49e25bd` (frontend
  rendering) → `93a912d` (e2e coverage) → `eaa37cd` (playbook).
- CI green on `dev` push + PR `#96`; merged to main (`64efdeb`); main CI +
  Deploy green on their own (no retries); live `/api/version` matched
  (`0.3.0-dev.53` @ `64efdeb`).
- **Follow-up found during post-deploy verification**: the new
  `SHOPTET_ADMIN_BASE_URL` was correctly read server-side (zod default),
  but `docker-compose.prod.yml` never listed it in the app service's
  `environment:` block — an operator setting it in `/srv/forestshop/.env`
  would have had no effect on the container. Fixed with the same bare-key
  pass-through pattern as `SHOPTET_EXPORT_URL`/`SHOPTET_ORDERS_URL`.
  Commits: `3f61748` (bump 0.3.0-dev.54) → `38f7655` (compose fix). CI
  green on `dev` push + PR `#97`; merged to main (`8c7780c`); main CI +
  Deploy green on their own; live `/api/version` matched (`0.3.0-dev.54`
  @ `8c7780c`); confirmed the container now genuinely sees the env var
  (`docker exec ... printenv SHOPTET_ADMIN_BASE_URL`).
- Live verification (`https://forestshop-novy.newlevel.media`): chips
  unchanged ("Všetci (39)", "BETALOV (7)", "(bez dodávateľa) (3)"),
  `product_supplier_override` 0 rows, `order_line.ordered` 0, `order_line`
  total 868, non-empty `order.comment` 0 — matches the required baseline
  exactly, before and after. Admin link `href` verified correct on a real
  row; 18 real unresolved lines currently carry the stale badge with
  plausible day counts (16, 57, 38, 48…); remark column shows "—" on all
  39 rows (real data rarely populates it, confirmed against the cached
  export earlier). Console: 0 errors/0 warnings.
- Shared PRs: `#96` (main implementation), `#97` (compose wiring
  follow-up).

## Issue 95 — "Na objednanie" prerobené na rýchlu pracovnú obrazovku

- Root cause + zvolený prístup + zamietnutá alternatíva zapísané na ticket
  PRED prvým commitom (issue komentár
  `#issuecomment-5143605125`): fixný `--fs-content-width` (1120px) na
  `.main > main` capoval VŠETKY záložky vrátane hustej tabuľky; tabuľka
  nemala vlastný `overflow-x` obal (posúvala sa celá stránka); 13 stĺpcov,
  viaceré takmer vždy prázdne/duplicitné, kradli miesto stĺpcu PRODUKT;
  malé klikacie ciele. Zamietnutá alternatíva: prerobenie z `<table>` na
  kartový layout (vyššie riziko pre celú existujúcu testovú sadu, bez
  reálneho prínosu navyše).
- Implementácia: `nav.ts`'s `wide` príznak (len záložka "orders") →
  `.main-wide` (ostatné obrazovky nezmenené) · `.orders-table-wrap`
  (overflow-x: auto) + `table-layout: fixed` + `<colgroup>` na KAŽDEJ
  skupine dodávateľa · presne tri zlúčenia stĺpcov, ktoré majiteľ sám
  navrhol (issue komentáre #10/#11): VEĽKOSŤ→KÓD (inline), PRIRADENIE
  DODÁVATEĽA→DODÁVATEĽ (jedna bunka, oba pôvodné testid-y zachované ako
  vnorené prvky), POZNÁMKA E-SHOPU+KOMENTÁR→POZNÁMKY (rovnaký vzor) — 13 →
  10 stĺpcov, nulová zmena správania/testid-ov · väčšie klikacie ciele
  scoped cez `.order-group ...` (Sync/ZmenaHesla obrazovky nedotknuté) ·
  zvyšné natvrdo px hodnoty prevedené na `rem`.
- **Sticky hlavička (mäkký bod 8 "zvážiť") vyskúšaná a ZAMIETNUTÁ**:
  `.orders-table-wrap`'s nutné `overflow-x: auto` robí z obalu scroll
  kontajner AJ pre zvislú os (CSS overflow computed-value pravidlo), čo
  presticky-uje `position: sticky` th voči tomuto malému obalu namiesto
  viewportu a posunie hlavičku CEZ prvý riadok bez toho, aby si tabuľka
  posun vyhradila v toku — reálny Playwright beh to chytil ako zlyhané
  `checkbox.click()` ("`<th>` intercepts pointer events"), nie len
  teoreticky. Fix by vyžadoval iný layout (mimo jednej `<table>`) za cenu
  vyššieho rizika — mimo rozsahu mäkko formulovaného bodu. Rozhodnutie aj
  na tickete a v `app.css` komentári.
- Deep code review (`superpowers:requesting-code-review`, dispatched
  subagent) našiel 2× 🟡 + 1× 🔵, všetky opravené v tej istej PR: orphaned
  `--fs-topbar-height`/`.topbar` min-height (zostatok po zamietnutej sticky
  funkcii, menil výšku Topbaru na VŠETKÝCH obrazovkách bezdôvodne) →
  odstránené; `.ord-supplier-assign-input`/`.ord-comment-input` mohli pri
  `min-width: 64rem` stropu na ~1280-1440px vizuálne pretiecť do suseda →
  pridané `max-width: 100%`; zastaraný komentár v existujúcom teste →
  opravený.
- **Živé post-deploy overenie odhalilo ĎALŠÍ nález** (po prvom merge):
  hlavička odškrtávacieho stĺpca ("OBJEDNANÉ") sa pri 4% šírke lámala
  UPROSTRED slova na tri riadky — spôsobené globálnym `overflow-wrap:
  break-word` aplikovaným aj na `<th>`. Fix: `overflow-wrap: break-word`
  teraz len na `<td>`, `col-ordered` 4%→6% (vzaté z `col-qty`/`col-date`,
  obe mali rezervu). Samostatná PR #103, samostatný CI cyklus (vrátane
  version-bump, keďže dev sa medzičasom zrovnal s main po merge #102).
- Testy: 3 nové vitest regresné testy (10 stĺpcov v hlavičke, zlúčené
  bunky Dodávateľ/Poznámky zdieľajú rodičovský `<td>`) + nové e2e
  assercie (žiadne vodorovné posúvanie stránky na 1280/1600/1920px + pod
  1.25× zoomom, v rámci existujúceho prvého testu, bez ďalšieho
  prihlásenia). Nový `apps/web/tests/e2e/tsconfig.json` (DOM lib) pre
  `page.evaluate()` type-aware lint.
- Commits: `78d7741` (bump .58) → `856dd30` (hlavná prerábka) →
  `477d7a9` (review fixes) → `8dfc414` (merge main) → `8c8e200` (header
  wrap fix) → `3d6f048` (bump .59). Shared PRs: `#102` (hlavná prerábka +
  review fixy), `#103` (header-wrap doladenie).
- CI zelené na oboch `dev` pushoch aj oboch PR (10/10 checks); main CI +
  Deploy zelené na oboch mergoch bez retry. Live `/api/version` = verzia
  vo footeri (`v0.3.0-dev.59`) na oboch nasadeniach.
- Live overenie (`https://forestshop-novy.newlevel.media/?tab=orders`):
  `document.body.scrollWidth <= window.innerWidth` na 1280/1600/1920px aj
  pod 1.25× zoomom; 160 `<th>` (16 skupín × 10 zlúčených stĺpcov)
  potvrdených cez DOM; 0 console chýb/varovaní. Produkčné dáta nedotknuté
  (len čítanie): `product_supplier_override`=0, `order_line.ordered`=0,
  `order_line`=868, objednávky s komentárom=0, `order`=528 — presne
  zhodné s očakávanou základňou pred aj po zásahu.
- Discord run-card odoslaný (`notify --run-card`, potvrdené doručenie).

## Issue #105 — Na objednanie: hlavičky sa zlievajú, KÓD zdvojuje veľkosť, riadok 135 px vysoký

- Live re-check po issue 95 (v0.3.0-dev.60) pri 1280/1600/1920px našiel 3
  zvyškové chyby: 4 hlavičky pretekali svoje bunky (`OBJEDNANÉ`/`OBJEDNÁVKA`/
  `MNOŽSTVO`/`DÁTUM OBJEDNÁVKY`, najhoršie pri 1280px = tabuľkin skutočný
  floor `min-width:64rem`); KÓD stĺpec zdvojoval veľkosť (`62621/5252`);
  riadok 135px vysoký (comment/supplier-assign vstup+tlačidlo zalomené pod
  seba).
- Design-rozhodnutie zapísané PRED kódom:
  `https://github.com/zbynekdrlik/forestshop-app/issues/105#issuecomment-5144365445`.
- RED→GREEN: `b3f006f` (red: `shouldShowSizeLabel` unit test) → `fc49f9a`
  (green: fix v `ordersSummary.ts`/`OrderLineRow.tsx` — sizeLabel je
  server-side literálny suffix `variantCode`u, `splitCode` v
  `map-row.ts`, pripájanie preto vždy duplikovalo). `ae11b4e` (red:
  rozšírený e2e width-check na 1440px + assercia na `th` pretekanie,
  potvrdené RED reálnym behom so starým CSS/TSX) → `cc3d2ba` (green:
  skrátené 4 hlavičky — checkbox stĺpec dostal ikonu "✓", `Č. obj.`, `Ks`,
  `Dátum obj.`, malá rezerva v colgroup percentách; `.ord-comment-input`/
  `.ord-supplier-assign-input` `flex-basis:0` + `flex-grow:1` + tuned
  `min-width` namiesto fixnej `width` — flexbox gotcha: `flex-basis`
  rozhoduje o zalomení pod `flex-wrap:wrap`, nie post-shrink veľkosť;
  `flex-shrink:0` na susedných tlačidlách; `.orders-table td` vertikálny
  padding 12px→8px). `8d00de2` (playbook: `DOM.Iterable` potrebné pre
  NodeList spread v e2e tsconfig).
- Shared PR: `#106`. CI zelené na `dev` pushi aj oboch PR CI behoch (5/5
  jobs); main CI + Deploy zelené bez retry.
- Nezávislý code review (general-purpose subagent na diff PR #106): 0 🔴
  0 🟡, 2 🔵 (obe explicitne "fine as-is" — DOM.Iterable doplnené do
  playbooku, endsWith bez case-guard zámerne ponechané pre nedosiahnuteľný
  prípad).
- Live overenie (`https://forestshop-novy.newlevel.media/?tab=orders`,
  39 reálnych riadkov): 0 pretekajúcich `<th>` pri 1280/1440/1600/1920px;
  KÓD naživo potvrdené presne uvedené príklady z ticketu ("62621/52",
  "61759/XL", "15813/120") bez zdvojenia; 0/39 comment ciel a 0/39
  supplier-assign ciel zalomených pri 1280px; výška riadku 84.5–116px
  (predtým 135px); 0 console chýb/varovaní; verzia vo footeri
  `v0.3.0-dev.61` zodpovedá `/api/version`.
- Discord run-card odoslaný (`notify --run-card`, potvrdené doručenie).

## issue 107 — STAV orezaný text, úzke POZNÁMKY, zbytočná pomlčka v DODAVATEL

- Commity na `dev`: `469f462` (bump 0.3.0-dev.63), `26e9e9f` ([red] test:
  supplier-assign-cell musí zmiznúť pre neradiťeľné riadky), `74ba34c`
  ([green] bod 3: neradiťeľný riadok nevykreslí blok priradenia dodávateľa
  vôbec), `002d06a` ([green] popis "Priradiť dodávateľa" presunutý do
  existujúcej `.ord-supplier-cell` — bez extra riadku výšky), `9e6ad99`
  ([red] `orders-layout.spec.ts` — STAV orezaný text + úzke POZNÁMKY),
  `791d78a` ([green] bod 1+2: `.ord-state-select`'s `appearance:none` +
  vlastná šípka, `col-state` 9%→14%, `col-notes` 12%→25%, financované zo
  `col-supplier`/`col-product`/ostatných).
- Shared PR: `#108` (zmergnuté, `49aeb92`). Main CI + Deploy zelené,
  v0.3.0-dev.63 nasadené.
- **Live post-deploy overenie odhalilo regresiu** (percentá stĺpcov
  overené LEN proti e2e fixtúre, nie proti skutočnej produkcii): 92 % z 39
  ostrých riadkov má "Odkaz na dodávateľa" + "kód XXXX" pod ním — dlhší
  obsah než e2e fixture testovala — ktorý sa v zúženom `col-supplier`
  zalomil na viac riadkov (`maxHeight` 85px→212px). Follow-up PR `#109`
  (`67b023c` bump 0.3.0-dev.64, `f4c67c4` oprava rozpočtu stĺpcov — live
  overené priamo proti produkcii cez `page.addStyleTag`, žiadny redeploy
  netreba na vyskúšanie kandidáta) — `col-supplier`/`col-product` späť na
  13%, financovanie z `col-order`/`col-code`/`col-ordered` (5%) a
  `col-customer` (8%). Zmergnuté, `69b9e0b`. Main CI + Deploy zelené,
  v0.3.0-dev.64 nasadené.
- Live overenie po opravnom deployi (`vychod@varos.sk`, 39 reálnych
  riadkov, 1280/1440/1600/1920px): 0 orezaných stavov, POZNÁMKY pole
  164–304px (≥160px), 0 pomlčiek v DODAVATEL bloku, 0 pretekajúcich `<th>`,
  0 vodorovného skrolovania stránky, `maxHeight` 134/134/114.5/95px
  (namiesto pôvodných 85–212px), 0 console chýb/varovaní, verzia vo
  footeri `v0.3.0-dev.64` zodpovedá `/api/version`.
- Playbook zápis: `.claude/rules/frontend-design.md` — overuj `<colgroup>`
  percentá proti SKUTOČNEJ produkcii, nie len e2e fixtúre.

## Issue #111 — číslo objednávky/kód sa lámu, pomlčka v poznámkach, 1280px overflow (2026-07-31)

- Nález pri vlastnej kontrole naživo po nasadení #107's fixu (v0.3.0-dev.65):
  1) číslo objednávky sa láme na 2-3 riadky (39/39 riadkov pri 1280/1600px),
  2) kód produktu sa láme (19/39 pri 1600px), 3) rozpočet stĺpcov obrátený
  (Č.OBJ./KÓD najužšie, POZNÁMKY skoro pätina tabuľky), 4) prázdna pomlčka
  "—" v POZNÁMKACH (39/39), 5) pri 1280px `.orders-table-wrap` preteká o
  58px, 💾 tlačidlo za viditeľným okrajom.
- Design decision zapísaný na tickete PRED prvým commitom
  (`4eb4f4d` bump 0.3.0-dev.66):
  https://github.com/zbynekdrlik/forestshop-app/issues/111#issuecomment-5145826005
- RED→GREEN: `OrderLineRow.remarkCell.test.tsx` (`c1d022e`→`4e32743`) —
  bare-dash fix, rovnaký tvar ako #107 bod 3.
- Layout fix (`525bca8`): `.ord-admin-link`/`.ord-code-cell` dostali trvalý
  `white-space: nowrap` + ellipsis poistku; `.main-wide`'s bočné odsadenie
  znížené (`--fs-space-6`→`--fs-space-1`, len táto obrazovka) a
  `.orders-table`'s `min-width` znížené 64rem→63.875rem, aby sa zmestila
  do reálne dostupnej šírky pri 1280px; celý 10-stĺpcový rozpočet prerobený
  a živo overený proti produkcii (`page.addStyleTag`, 39 riadkov,
  `vychod@varos.sk`) na 1280/1440/1600/1920px.
- PR `#112` zmergnuté (`18ffdec`). Main CI zelené. Deploy job zlyhal raz na
  tranzientný sieťový timeout (`ghcr.io` pull, `dial tcp ... i/o timeout`) —
  `gh run rerun --failed` prešiel hneď napodruhé; nešlo o obsah image.
- Live overenie po deployi (`vychod@varos.sk`, 39 reálnych riadkov,
  1280/1440/1600/1920px): 0 zalomených čísiel/kódov na VŠETKÝCH šírkach,
  0 pretekajúcich `.orders-table-wrap`/`<th>`, 0 pomlčiek v poznámkach,
  STAV/POZNÁMKY rezervy zachované, 0 console chýb/varovaní, verzia
  `v0.3.0-dev.66` zodpovedá živému DOM-u. Produkčné dáta nedotknuté
  (order_line 868, ordered 0, state≠'objednane' 0,
  product_supplier_override 0, "order" 528).
- Prijatý kompromis: pri 1280px zriedkavý `supplierAssignable` riadok môže
  zalomiť na 2 riadky (existujúca `flex-wrap` poistka z #105) — priemerná
  výška riadku pri 1280px vyššia o ~11px, pri 1440px+ rovnaká/lepšia.
- Playbook zápis: `.claude/rules/frontend-design.md` — 4 nové položky
  (`getClientRects()` na `<td>` vždy vráti 1, `white-space:nowrap` ako
  TRVALÁ poistka popri šírke, `.main-wide` odsadenie/`min-width` ako prvá
  vec na kontrolu pri "tabuľka sa nezmestí", párové porovnanie výšky
  riadkov namiesto surových min/median/max).
