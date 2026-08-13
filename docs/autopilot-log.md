# Autopilot Log

Terse per-ticket log of autopilot-worker cycles: issue(s), commit SHAs,
RED→GREEN test names, key decisions, and the shared PR.

## 2026-08-02 — #173 (Pripomienky objednávok — order-reminder automation)

- Solo ticket, owner-approved (comment on the issue removed `autopilot-skip`,
  same batch as #172/#176: "vsetky tri veci").
- Version bump `e3ec8fb` (0.3.0-dev.104→.105), first commit.
- Design comment BEFORE first code commit:
  https://github.com/zbynekdrlik/forestshop-app/issues/173#issuecomment-5160112598
  — root cause/approach: same architecture as #172 (settings singleton +
  per-order state + `job_run.detail` as display source of truth), but a NEW
  injected `ClassifyClient` (OpenAI chat completions, ported prompt from
  `orders_reminder.py`), single permanent email (never a cadence like #172's
  4-step escalation), and Postgres `pg_advisory_lock` serialization for BOTH
  the whole run AND every manual per-row override — REJECTED alternative:
  copying the old app's file-based `sending`-claim+TTL mechanism (unnecessary
  once Postgres gives transactional serialization for free).
- Two design bugs found and fixed DURING test-writing (before any push):
  1. The fast-path gate originally required `fingerprint === fp` to treat a
     resolved order as terminal — verified against the old app's actual code
     (`app.py:9013`) that `resolution` must be permanent REGARDLESS of
     fingerprint change, or a note edited after the email went out would
     trigger a second send. Fixed; regression test "ZMENA poznámky po
     odoslaní e-mailu sa AJ TAK nespracuje druhýkrát".
  2. The manual override endpoint mutated only `order_reminder_state`, never
     the last `job_run.detail` — `GET` right after a successful override
     still showed the OLD list (row invisible on screen until the next run).
     Fixed with `relocateAfterOverride` in `order-reminder-routes.ts`; caught
     by the project's OWN e2e test before the push, not by later review.
- Backend commit `c45d922`: schema (`order_reminder_settings`/
  `order_reminder_state`, migration `0022_famous_sunspot`), `modules/
  order-reminder/{constants,logic,orders-source,settings,state,classify-
  client,run}.ts`, `http/order-reminder-routes.ts`, `env.ts`
  (`OPENAI_API_KEY`/`ORDER_REMINDER_BCC_EMAIL`, both optional), scheduler job
  (daily 06:00 UTC ≈ 08:00 Europe/Bratislava CEST), `index.ts`/`app.ts`
  wiring, TRUNCATE+reseed in both `tests/helpers/db.ts` and
  `scripts/e2e-setup.ts`. 16 logic unit tests, 13 run + 11 http integration
  tests (incl. deterministic advisory-lock serialization proof via
  `pg_try_advisory_lock` from a second connection).
- Frontend commit `4f15ba9`: `orderReminderApi.ts`, `OrderReminderSection
  .tsx`/`OrderReminderRow.tsx` (🔴 bez poznámky + ✉️ bez e-mailu + 🟠 odoslané
  + preskočené/⚪⚪✋⚠️ merged group), new HIDDEN tab `?tab=order-reminder`
  (owner still wants only two visible nav items, #57) — own visual design
  per `.claude/rules/frontend-design.md`, not the legacy app's look. 11 web
  unit tests.
- e2e commit `ead1271`: `order-reminder.spec.ts` — new isolated e2e account
  (`e2e-pripomienky@forestshop.sk`), uses the STABLE fixture order "9002"
  (no note, no email, never mutated by any other spec) to exercise both
  manual-action buttons deterministically; also carries the
  `relocateAfterOverride` fix + its own new HTTP regression test.
- Deploy config commit `27f4a08`: wired `OPENAI_API_KEY`/
  `ORDER_REMINDER_BCC_EMAIL` through `docker-compose.prod.yml` as bare
  (optional) keys, same pattern as `POSTA_UNCOLLECTED_BCC_EMAIL`.
- Locally verified before push: api unit clean, api integration 341/341
  (incl. both new files, 24 new tests), web unit 307/307 (incl. new 11), web
  e2e 27/27 (incl. new spec), `pnpm lint`/`pnpm typecheck` clean throughout.
- Review comment (issue-comment-5160259957): self `/review` pass, 0🔴 0🟡
  0🔵 remaining (both design bugs above were fixed pre-push, not left open).
- PR #180 — `Closes #173` deliberately NOT used (ticket has a live
  post-deploy acceptance condition: verify deployed disabled + zero customer
  emails, `.claude/rules/CLAUDE.md`'s auto-close lesson) — CI (push run
  30766346745 and PR-triggered run 30766366532) both `success`, PR
  `MERGEABLE`+`CLEAN` → merged `058397c` (merge commit).
- Main CI (run 30766513085) and Deploy (run 30766513075) monitored after
  merge — both `success`.
- Live verified (Playwright MCP, owner admin account): `/api/version` =
  `0.3.0-dev.105`/`058397c`. DB on dev2: `order_reminder_settings.enabled =
  f` (deployed disabled, as promised). Clicked "Spustiť teraz" against REAL
  production data (16 real candidate orders, neither `OPENAI_API_KEY` nor
  `ORDER_REMINDER_BCC_EMAIL` provisioned on dev2 yet) — both banners showed
  correctly, 1 real no-note order rendered in 🔴 with both action buttons, 15
  real noted orders correctly blocked in "Preskočené" with the AI-unavailable
  reason, **0 e-mails sent** (confirmed both in the UI stats AND directly in
  the DB: `select count(*) from order_reminder_state` → 0 rows — live data
  left exactly as found). Preview button tested on a real row (showed real
  recipient/subject, no send). Console: 0 errors/warnings.
- Issue #173 closed with evidence (issue-comment-5160303071). Discord card
  fired (`notify --run-card`).

## 2026-08-02 — #172 (Nevyzdvihnuté zásielky — Slovak Post uncollected-parcel automation)

- Solo ticket, owner-approved (comment on the issue removed `autopilot-skip`).
- Version bump `7a736d8` (0.3.0-dev.101→.102), first commit.
- Design comment BEFORE first code commit:
  https://github.com/zbynekdrlik/forestshop-app/issues/172#issuecomment-5159652624
  — root cause (new `order` columns needed: `email`/`phone`/`package_number`/
  `shipping_carrier_name`, extracted independently of `mapOrderRow`'s
  item-validation since the SHIPPING pseudo-row carries the carrier name and
  is otherwise discarded), chosen approach (DB-native reimplementation of the
  old app's `posta_uncollected.py`: `job_run.detail` reuse for display state,
  a new `posta_uncollected_state` table for escalation counters, `enabled`
  gates ONLY the scheduled job never the fail-closed send path — matching
  the old app's `run_now` semantics), rejected alternatives (CSV re-parse,
  state-in-job_run, generic `MAIL_BCC`, gating manual-run on `enabled`).
- STILL-VALID comment: https://github.com/zbynekdrlik/forestshop-app/issues/172#issuecomment-5159654395
- PR #177 (`feat: Nevyzdvihnute zasielky automation`) — schema (migration
  `0021`), `orders/parser.ts` extraction (`extractOrderLevelExtra`/
  `mergeOrderLevelExtra`), `modules/posta-uncollected/**` business logic
  (verbatim-ported e-mail templates, cadence, coverage/blind-spot
  safeguard), scheduler job, HTTP routes, web UI (hidden tab
  `?tab=posta-uncollected`), `docker-compose.prod.yml` wiring for the new
  `POSTA_UNCOLLECTED_BCC_EMAIL` var. Merged `42e496a`.
  - Independent review (dispatched fork) found and fixed 2 real issues
    BEFORE this could be called done, both with deterministic regression
    tests: (1) `runPostaUncollected` had no advisory lock — two overlapping
    runs (manual + scheduled, or two managers) could double-send the same
    escalation e-mail; fixed with `POSTA_UNCOLLECTED_RUN_LOCK_KEY`
    (`787_878_004`, session-scoped `pg_advisory_lock`). (2) the order
    upsert directly overwrote `email`/`phone`/`package_number`/
    `shipping_carrier_name` from `excluded` instead of `coalesce`-ing like
    `shoptet_order_id` already does — a transient export glitch could have
    silently nulled a known package number and made the automation stop
    tracking that shipment with no warning. PR #178 carried both fixes +
    the playbook entry (`.claude/rules/posta-uncollected.md`) + version
    bump `898d05e` (0.3.0-dev.102→.103). Merged `ef64bd4`.
  - Regression tests: `posta-uncollected-run.integration.test.ts`'s "dva
    súbežné behy sa serializujú" (RED without the lock — proven
    deterministically via `pg_try_advisory_lock` from a second connection,
    same technique as `db-isolation-lock.integration.test.ts`), and
    `orders-ingest-posta-fields.integration.test.ts`'s "re-import ...
    NEVYNULUJE" (RED without the coalesce).
- Post-deploy verification (live, `vychod@varos.sk`): version `v0.3.0-dev.103`
  read from DOM, console zero errors/warnings. Confirmed via SSH DB query
  that `posta_uncollected_settings.enabled = false` (ships disabled, per the
  ticket's one absolute safety condition). Triggered a REAL "Spustiť teraz"
  run against real production data (safe: no `POSTA_UNCOLLECTED_BCC_EMAIL`
  configured yet on dev2, so the fail-closed BCC check blocks every send
  regardless) — confirmed a real uncollected shipment (order 20261239,
  package EF256985125SK) renders correctly in the table with a working
  direct Shoptet admin link and Slovak-post tracking link, and that the
  preview endpoint shows the exact e-mail that would go out. Restored
  `enabled=false` afterward (was toggled on only for this verification).
  Docs-only follow-up (autopilot-log entry, this commit) bumped version to
  `0.3.0-dev.104` — deployed + verified separately (see PR / commit list).
- `POSTA_UNCOLLECTED_BCC_EMAIL` and (once ready) Štart/Stop remain the
  owner's own action — nothing will ever send a customer e-mail until both
  are set, by design.

## 2026-08-01 — #153 (immediate supplier-link validation + CSV formula-injection guard)

- Solo ticket (security-boundary Scope-gate, deliberately not bundled).
- Version bump `239c241` (0.3.0-dev.93→.94), first commit.
- Design comment BEFORE first code commit:
  https://github.com/zbynekdrlik/forestshop-app/issues/153#issuecomment-5151009096
  — traced the CSV write-back path (`select-changes.ts`→`csv.ts`) and found
  only `internalNote` (the manual supplier-link URL) is user-hand-entered
  AND reaches the generated CSV; `code`/`pairCode` come from the catalog
  import. Since the URL is already anchored `^https?:\/\//`, a formula-lead
  value can never pass it anyway (matches the reference app's OWN design —
  it never adds a separate formula-check on ITS url fields either, only on
  its supplier-NAME field which has no other shape rule). Chose: (1)
  `csvSafe` escaping at the CSV SINK (`csv.ts`'s `dataRowToLine`) protecting
  EVERY column including `code`/`pairCode`, matching the sibling app's own
  `_csv_safe`; (2) an explicit `.refine()` on the schema anyway — defense in
  depth, independently testable (zod does NOT short-circuit chained string
  checks — a later `.refine()` still adds its own issue even when an
  earlier `.url()`/`.regex()` check on the same value already failed, see
  `.claude/rules/http-routes.md`).
- RED→GREEN, four pairs (security ticket, strict TDD):
  `877020e`[red]→`2a314b1`[green] (CSV-sink formula escaping,
  `formula-guard.test.ts`/`csv.test.ts`), `14ccd4b`[red]→`9113f9d`[green]
  (schema-level explicit reject, `orders-supplier-link-assignment
  .integration.test.ts`'s "vráti 400 so samostatnou hláškou o vzorci"),
  `1910c6b`[red]→`5e8bf33`[green] (`validateSupplierLinkUrl`,
  `ordersApi.supplierLink.test.ts`), `d265d83`[red]→`b698262`[green]
  (wired into `OrdersSection`'s `setSupplierLink`,
  `OrdersSection.supplierLinkValidation.test.tsx` — proves the API is
  never called for an invalid link). Extracted `useSupplierLinkSave.ts`
  (behaviour-preserving) to keep `OrdersSection.tsx` under eslint
  `max-lines: 400` after adding the validation branch — same pattern as
  the earlier `useSupplierEmailEditing.ts` extraction.
- New e2e test in `orders-supplier-link.spec.ts`: an invalid link is
  rejected with console staying CLEAN — proof the request never actually
  reached the network (a real server 400 would have logged "Failed to
  load resource" in Chromium, per `.claude/rules/testing.md`).
- **Merge incident (PR #159):** `gh pr merge --merge` returned a GraphQL
  error but had partially succeeded server-side — `main`'s ref moved to
  the real merge commit (`d53e302`, content verified identical to `dev`
  via `git diff`), but the PR object stayed open/unmerged AND the commit
  got zero check-suites/check-runs (no CI, no Deploy ever ran). Closed
  PR #159 manually with an explanatory comment; recovered by bumping the
  version again (0.3.0-dev.94→.95) and pushing this very log entry as a
  fresh commit (own PR) so a normal push event re-triggers CI+Deploy over
  the full current `main` tree, including #153's already-landed content.
  Full gotcha + recovery steps: `.claude/rules/ci.md`.
- Playbook extended: `.claude/rules/ci.md` (the `gh pr merge`
  partial-failure/no-CI-triggered gotcha + recovery), `.claude/rules/
  http-routes.md` (zod `.refine()` after a failing check still runs —
  useful for adding an independently-testable guard even when logically
  redundant with an earlier check), `.claude/rules/shoptet-writeback.md`
  (CSV-injection guard sits at the `csv.ts` sink, not upstream validation
  — any future writeback column is automatically protected as long as it
  goes through `buildWritebackCsv`).

## 2026-08-01 — #151 (supplier draft lost across group remount) + #152 (sort by newest order)

- Version bump `9029b0a` (0.3.0-dev.90→.91), first commit on `dev`.
- Design comments BEFORE first code commit, both revised once each
  investigation found more than initially assumed:
  https://github.com/zbynekdrlik/forestshop-app/issues/151#issuecomment-5150635978
  (initial: dirty-ref guard, same shape as `commentDraft`/issue 64) →
  https://github.com/zbynekdrlik/forestshop-app/issues/151#issuecomment-5150669944
  (revised AFTER writing + empirically running the regression test: any
  `manualSupplierOverride` change ALWAYS moves the row to a different
  `SupplierOrderGroup` — `key={group.supplier}` — which is a React REMOUNT,
  not a re-render, confirmed via `document.contains()` on the old DOM node
  returning `false`; a per-instance ref/effect cannot survive that, the
  draft must live one level up, in `OrdersSection`, which never remounts).
  https://github.com/zbynekdrlik/forestshop-app/issues/152#issuecomment-5150637223
  (SQL aggregation rejected — `effectiveSupplier` isn't a plain column
  `ORDER BY` can use; `acc.lines[0]` from the already-`desc(placedAt)`-sorted
  rows is free and sufficient).
- RED `5860661` / GREEN `e67a6dc` (#151): new test in
  `OrdersSection.assignSupplier.test.tsx` ("rozpísaný, ešte neuložený
  koncept priradenia dodávateľa na riadku A PREŽIJE uloženie dodávateľa cez
  SÚRODENECKÝ riadok B") — RED reused the same stale-reference mistake the
  fix itself had to avoid (see playbook entry below) before landing on the
  correct fresh-DOM-query assertion. GREEN: new `useSupplierDrafts.ts` hook
  (`Map<lineId, draft>` living in `OrdersSection`, same principle as
  existing `useDirtyEditorLineIds.ts`/#149) + `OrderLineRow.tsx`'s
  `supplierDraft` becomes a derived value
  (`pendingSupplierDraft ?? line.manualSupplierOverride ?? ""`) instead of
  local `useState`/reset-`useEffect`/dirty-ref. Also extracted
  `useSelectedSupplierFallback.ts` (#148 logic, zero behavior change) purely
  to stay under eslint `max-lines: 400` in `OrdersSection.tsx`.
- `7f5b839` (feat, #152): `queries.ts`'s `groups.sort` comparator changed
  from alphabetical to `acc.lines[0].placedAt` descending (tie-break
  alphabetical, "(bez dodávateľa)" always last, unchanged). New file
  `orders-http-supplier-order.integration.test.ts` (3 tests: date order incl.
  reverse-alphabetical fixture, tie-break, "(bez dodávateľa)" last even with
  the newest order of all).
- Local verification before push: web unit 275/275, API unit 323/323, API
  integration 293/293 (45 files), Playwright e2e 24/24 (zero console
  errors) — all green before the single push/PR/CI cycle.
- PR #156, merged `796f28c`. Main CI + Deploy both green
  (v0.3.0-dev.91, commit `796f28c`).
- Live-verified on production (`forestshop-novy.newlevel.media`): #152 —
  group order visibly newest-first, "(bez dodávateľa)" last. #151 — since
  the override tables held 0 rows at verification time (no real product
  currently had 2+ open unassigned sibling lines), a TEMPORARY test order
  (`TEST-ISSUE151-VERIFY`, 2 lines of one real unused-in-orders product,
  RUKAVICE GRAB VEIL M SWEDTEAM variants `5141/M`/`5141/L`) was inserted,
  the exact bug scenario reproduced (unsaved draft on `5141/M` survived the
  group-remount triggered by saving `5141/L`'s assignment — both moved into
  a new "TEST-DODAVATEL-VERIFY — 2 riadky" group live), then fully removed
  (override row + both order_line rows + the order row; audit_events left,
  append-only). DB baseline re-checked after cleanup: exactly
  `0|0|534|878|0`, matching the pre-work baseline. Both issues closed
  MANUALLY (not via PR `Closes #N`) after this live verification, per
  `CLAUDE.md`'s note.
- Playbook: `.claude/rules/frontend-design.md` gets a new entry — a
  prop-syncing pattern (controlled draft + reset `useEffect` + dirty guard,
  the established shape for `commentDraft`/#64) is the WRONG fix whenever
  the prop change also implies the row moves to a different keyed React
  parent (a group/section reassignment) — that is a REMOUNT, and the fix
  has to live in the ancestor that survives the remount, not a ref/effect
  in the component that doesn't. Also: a regression test asserting a value
  survived a refetch must re-query the DOM fresh, never reuse the
  pre-refetch element handle — a stale/detached reference keeps its last
  `.value` regardless of what the live DOM shows, which gives a false GREEN
  even against genuinely broken code (caught here only because the test was
  run against unfixed code FIRST and still passed, which is exactly what
  the RED step exists to catch).

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

## Issue #120 (2026-07-31) — order admin link opens objednavky-detail via internal Shoptet id

- Version bump `175ffe9` (0.3.0-dev.72). Design comment posted BEFORE code:
  https://github.com/zbynekdrlik/forestshop-app/issues/120#issuecomment-5147522527
  — investigated the REAL Shoptet exports live on dev2: the CSV order export
  (`SHOPTET_ORDERS_URL`, 67 columns) genuinely has no internal order id (the
  older `.claude/rules/orders.md` note was correct for CSV); a SEPARATE XML
  export (`patternId=-11`) does carry `<ORDER_ID>`, verified live
  (`20260897` → `58656`).
- Feature commit `e572ef9`: `SHOPTET_ORDERS_XML_URL` (optional, best-effort),
  `createHttpOrderIdsFetcher`/`extractOrderIdsFromXml`, migration 0016
  (`order.shoptet_order_id` nullable integer, `COALESCE`-refreshed),
  `buildShoptetAdminOrderUrl` builds `/admin/objednavky-detail/?id=<id>` when
  known else falls back to the existing `/admin/vyhladavanie/` search link.
  Tests: `queries.test.ts` (new, unit), `parser.test.ts` +
  `fetcher.test.ts` additions (unit), `orders-ingest.integration.test.ts` +
  `orders-http-annotations.integration.test.ts` additions (integration,
  best-effort-failure + COALESCE-preserves-old-id cases). No RED/GREEN split
  (feature, not a bug fix — tests written alongside implementation per
  tdd-workflow.md).
- Commit `1fc2106`: wired `SHOPTET_ORDERS_XML_URL:` (bare key) into
  `docker-compose.prod.yml`; updated `.claude/rules/orders.md`'s stale
  "Shoptet admin has no internal id" note (only ever true for CSV).
- Configured `SHOPTET_ORDERS_XML_URL` in `/srv/forestshop/.env` on dev2
  BEFORE the PR merged, so the very first deploy would pick it up.
- PR #128 merged (`29a85476`). Main CI + Deploy green.
- Post-deploy: triggered a manual "Stiahnuť teraz" orders import — DB shows
  531/533 orders now carry `shoptet_order_id`. Order `20260921` resolved to
  `id=58728` — the EXACT example id the owner gave in the ticket. Row height
  at 1280px unchanged (min 79.5 / median 91 / max 114.5, 0 over 120), 0
  console errors/warnings.
- **Left OPEN**: the ticket's own acceptance criterion (click ≥2 links,
  confirm Shoptet renders the correct order) needs a real login to Shoptet's
  OWN admin (`forestshop.sk/admin`, separate from the app) — asked the owner
  for it (comment + `needs-answer` label on #120), tracked, not fabricated.
  Everything else (code, migration, deploy, DB enrichment, no regressions)
  is done and verified.
- Filed #129 (pre-existing, unrelated): a stray NUL byte in
  `queries.ts`'s `NULL_GROUP_KEY` (from issue 63's `ead8ae3`, long before
  this PR) makes `git diff` treat the whole file as binary — found by the
  code-review subagent dispatched before merge, confirmed independently.
- Playbook: `.claude/rules/orders.md` updated (see above); memory
  `shoptet-export-urls.md` updated to record the XML export is now
  actively consumed, not just "supplied for later phases".

## Issues 127, 129, 132 — bundled batch (2026-08-01)

- Version bumped to `0.3.0-dev.75` (`c34597b`), first commit on `dev`.
- Design-decision comments posted on all three tickets BEFORE any code
  commit (root cause + chosen approach + rejected alternative for each).
- **#129** (NUL byte in `queries.ts`'s `NULL_GROUP_KEY`): RED test
  (`1ee8001`, reads raw source bytes, asserts no `\x00`) -> GREEN fix
  (`a712df9`, replaced with a plain space). `git diff` on `queries.ts` is
  now a normal text diff. Full 290-test unit suite + 239-test integration
  suite unaffected.
- **#132** (id-backfill window widening): RED integration test
  (`a08724c`, `orders-id-backfill.integration.test.ts` -- module didn't
  exist yet, confirmed `Cannot find module`) -> GREEN
  (`cf9efca`, new `apps/api/src/modules/orders/backfill.ts`:
  `findOldestOpenOrderMissingShoptetId` + `computeOrderIdsWindowStart`,
  wired into `index.ts` + `cli/orders-ingest.ts`). Self-healing: widens
  the XML id-fetch window (never the main CSV import's own window) only
  while an open order is missing its id.
- **#127** (stale-badge overflow): RED e2e test (`0b47b89`,
  `orders-layout.spec.ts` -- measured 35.125px spill against the OLD
  styling, matching the ticket's live-measured ~22-35px depending on day
  count) -> GREEN (`b637050`): compact badge text ("N d", full "N dni" in
  `title`), `col-date` 6%->9%, `col-product` 17.4%->14.4%, permanent
  ellipsis safety net. Every other column tested live against production
  first (`page.addStyleTag`, 37 real rows) as a candidate width donor --
  `col-notes`/`col-supplier`/`col-customer`/`col-qty`/`col-state`/
  `col-order` all regressed something already measured today
  (comment-input floor, 3 real supplier-assign rows pushed over 120px,
  near-universal customer-name wrapping, zero/negative slack) --
  `col-product` was the only column with genuine verified slack.
- Local full-suite verification before push: typecheck clean, lint clean,
  API unit (290 tests) + integration (239 tests) green, web unit (236
  tests) green, full local e2e suite (21 tests, all 6 spec files) green.
- Pull request opened for this batch: `Closes #127`, `Closes #129`.
  Issue #132 deliberately NOT closed by that PR -- its acceptance
  criterion (0 rows using the search fallback once Shoptet has the id)
  needs a real ingest run against the live XML export post-deploy, same
  reasoning as the #120 premature-close gotcha above. Will trigger manual
  ingest post-deploy, verify live, close #132 manually with evidence.

## Post-deploy findings on the 127/129/132 batch (same day)

- **#127 regression, found by post-deploy live verification (not caught
  pre-merge):** the first fix took the full +3 points col-date needed
  entirely from col-product. Live-verified OK against production's data
  AT THAT MOMENT — but a genuinely new real order (20261267, an
  exceptionally long product name) arrived right after deploy and its row
  crossed 120px (134px; would have been 114.5px at the original width).
  Live column budgets have no content ceiling, so verifying ONE candidate
  against a snapshot never proves a NEW future row won't hit the same
  boundary. Fix (PR to main, commit `50894bf`): found the actual safe
  boundary per donor column (not just one candidate) — col-product
  tolerates down to 15.4% (not 14.4%), col-supplier has a separate 1-point
  budget down to 13%. Re-verified live after redeploy (`v0.3.0-dev.76`):
  max back to 114.5px, 0 over 120px.
- **GitHub auto-close false-positives, hit 3 times in this batch:**
  GitHub's closing-keyword scan matches `close|closes|closed|fix|...`
  immediately followed by `#N` ANYWHERE in a PR body, with NO word-boundary
  exemption for compound words — "auto-closed #132" matched as "closed
  #132" and closed #132 prematurely (twice, from two different PR bodies
  discussing the earlier premature-close incident). Neither PR had a
  `Closes #N` trailer for that issue. Lesson for ANY future PR body: never
  write ANY of those keywords immediately before a bare issue number,
  including inside a compound/hyphenated word — reopen + comment
  immediately if it happens, and reword to avoid the pattern entirely
  (e.g. spell out "auto closed" as two words, or refer to the issue as
  "issue 132" instead of "#132" when discussing it in prose near those
  verbs).
- **#132's real root cause was deeper than the first fix (window
  widening alone):** discovered ONLY by triggering a REAL production
  ingest and checking the DB directly — the widened XML id-fetch window
  correctly found the order's id, but the COALESCE write only happens
  inside the CSV-driven upsert loop (`orderInfo`), which never contains
  an order older than the CSV's own (intentionally unwidened) 90-day
  window. Second fix (PR to main, commit `5eb8a8f`): a direct backfill
  UPDATE for every XML-known id not covered by the CSV batch. Verified
  live after redeploy (`v0.3.0-dev.77`): DB shows both 20260739
  (id 58184) and 20260740 (id 58187) with ids; 0/37 "Na objednanie" rows
  use the search-fallback link (was 1/37).
- All three per-ticket Discord cards fired after final verification
  (`v0.3.0-dev.77`).

## Issue 121 — manuálny odkaz na dodávateľa (doplniť/upraviť pri každom produkte)

- PR #138, merge `6b67f75`, deployed `v0.3.0-dev.80` (curl `/api/version` matches
  merge SHA exactly).
- Design comment posted BEFORE first commit:
  https://github.com/zbynekdrlik/forestshop-app/issues/121#issuecomment-5148523005
- New table `product_supplier_link_override` (migration 0017) — mirrors
  `product_supplier_override` but the stored link ALWAYS wins over the
  Shoptet-extracted `internalNote` link (no "already has one" 409 gate — the
  owner wants every product editable, including ones that already have a
  link). New pure resolver `effective-supplier-link.ts`
  (`resolveEffectiveSupplierLink`) shared by all three read paths
  (`queries.ts` ×2, `mail.ts`).
- Frontend: pencil toggle SIBLING of (never inside) the existing tested
  `.ord-supplier-cell` div — the inline edit input only renders while open,
  so it adds zero row height to the 34+ rows not being edited (protects the
  issue 105/107/111/127 ~120px row-height ceiling).
- Code review (background subagent, PR 138 diff) found 2 🔵 (no 🔴/🟡):
  coverage gap (only 1 of 3 read paths had a direct test) — fixed with 2
  more integration tests (`getOrderDetail` + supplier mail preview); the
  second (`SELECT` without `FOR UPDATE` on the audit "previous value" read)
  mirrors the EXISTING accepted pattern in `assignOrderLineSupplier` — left
  as-is, consistency with established repo convention.
- e2e: new isolated login (`e2e-odkaz@forestshop.sk`) + seeded order 9007 on
  previously-unused single-variant fixture product "278" — NOT `4859/*`
  (`orders.spec.ts` hard-asserts `4859/46`'s exact href, and the override is
  product-keyed so touching any `4859/*` variant would have broken it).
  Bumped `orders.spec.ts`'s shared global count assertions (Všetci 6→7,
  "(bez dodávateľa)" 3→4) — counted explicitly, not guessed.
- Live post-deploy verification (Playwright, admin account, order 20261059 /
  12314/3XL8): doplniť → upraviť → reload-persists all confirmed, 0 console
  errors/warnings. Row-height baseline unchanged (38 rows, min 87.75/med
  91.25/max 114.5px, 0 over 120px, 38/38 admin links to `objednavky-detail`,
  0 horizontal scroll) before AND after the test. Production data restored
  exactly: `product_supplier_link_override` back to 0 rows,
  `product_supplier_override` unaffected at 0, `order`/`order_line` counts
  unchanged (534/878). Audit rows (append-only) kept.
- Issue 121 closed by hand (not via `Closes #`) — this repo's PR body
  intentionally omits any close keyword since the ticket's acceptance needed
  a post-deploy live check, per the CLAUDE.md gotcha from #120/#127/#132.

## issue 122 (2026-08-01, 0.3.0-dev.83)

- Spätný zápis odkazu na dodávateľa do Shoptetu — hromadný CSV import cez
  Playwright (majiteľovo doslovné zadanie). Nový modul
  `apps/api/src/modules/shoptet-writeback/`: `csv.ts` (buildWritebackCsv —
  code;pairCode;internalNote, UTF-8 BOM, `;`, CRLF), `log-attribution.ts`
  (pure baseline+expectedRows atribúcia, port zo sesterského
  `parovanie_produktov`), `config.ts`, `select-changes.ts`
  (`synced_at IS NULL OR synced_at < updated_at`), `mark-synced.ts`,
  `playwright-import.ts`, `run-writeback.ts` (orchestrátor).
- Migrácia 0018: `product_supplier_link_override.synced_at` (nullable
  timestamp).
- Nová hodinová úloha `shoptetWritebackJob` (`:50`).
- Design komentár: https://github.com/zbynekdrlik/forestshop-app/issues/122#issuecomment-5148829794
- RED/GREEN commity: csv.ts (d3ad809), log-attribution.ts (ec95b38),
  config.ts (baa0867), select-changes.ts (31e4da3), mark-synced.ts
  (3360c77), playwright-import.ts (18405c0), run-writeback.ts (9319fde),
  scheduler wiring (6a14756), deploy wiring (ed2328a).
- Deep review (requesting-code-review skill, subagent): 0 🔴 1 🟡 3 🔵, všetky
  opravené pred mergom:
  - 🟡 race medzi select a mark-synced (aff5047 RED → 01b76f9 GREEN):
    `markSuppliersLinksSynced` teraz vyžaduje aj `updatedAt <= now` (now =
    čas ZAČIATKU behu, nie čas zápisu) — úprava počas (dlho bežiaceho)
    Playwright importu sa už nikdy nestratí.
  - 🔵 mŕtvy kód `entryKey` (8045f4e) — zapojený do `pollForResult`'s
    dedup, presne ako sesterský projekt.
  - 🔵 tichý no-op pre override bez variantu (aea5a81) — teraz zaloguje
    varovanie.
  - 🔵 `resultExitCode`'s `failed===null` sémantika — zdokumentovaná
    (zámerná, nie bug).
- PR #140 (hlavná implementácia) + PR #141 (kritický fix zistený AŽ pri
  naživo overovaní): priamy `setInputFiles` na skrytý file input NEFUNGUJE
  proti reálnemu Shoptetu (React widget potrebuje skutočný file-chooser cez
  viditeľné tlačidlo "Vyberte súbor") — port presného postupu zo
  sesterského `parovanie_produktov`. Fixture upravená, aby mala rovnaký
  tvar (pred touto opravou by testy prešli aj so ZLOU implementáciou).
- Alpine chromium v produkčnom Docker image (`apk add chromium` + font/NSS/
  freetype balíky, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) — overené naživo
  v throwaway kontajneri (Playwright's `chromium.launch({executablePath})`
  proti apk-installed chromiu) PRED commitnutím.
- `docker-compose.prod.yml` doplnené o `SHOPTET_ADMIN_USER`/`PASSWORD`
  (predtým appka mala k dispozícii len `SHOPTET_ADMIN_BASE_URL`, hoci
  `/srv/forestshop/.env` mal všetky tri kľúče).
- Naživo overené na PRESNE jednom produkte (Vnadidlo Bukový decht 2,5 l,
  kód 60286): appka → override → spätný zápis → Shoptet export potvrdil
  zmenu presne v `internalNote` stĺpci, nič iné sa nedotklo → odkaz vrátený
  na pôvodnú hodnotu → spätný zápis znova → export potvrdil pôvodnú
  hodnotu → `product_supplier_link_override` vrátená na 0 riadkov
  (produkčný baseline pred testom).
- Testy: 41/41 integration test files (272 testov), 20/20 unit test files
  (314 testov v apps/api), web e2e 22/22 — všetko zelené IZOLOVANE (nie
  súbežne s inou DB-závislou suitou, ktorá kolíduje na zdieľanej lokálnej
  Postgres — nie skutočná chyba, len self-inflicted konkurencia).
- Issue 122 zavreté ručne (nie cez `Closes #`) s dôkazom v komentári — rovnaký
  dôvod ako issue 121 (acceptancia potrebovala post-deploy živú kontrolu).
- Nový playbook súbor `.claude/rules/shoptet-writeback.md` (reálne Shoptet
  admin cesty, file-chooser gotcha, Alpine chromium recept, race-condition
  vzor pre "vyber → dlho bežiaci zápis → označ hotové", cp1250 export
  encoding, docker-cp verifikačný postup).

## issue 123 (2026-08-01, 0.3.0-dev.85)

- Spätný zápis appkinej poznámky k objednávke (`order.comment`) do Shoptet-
  ovho "Poznámka e-shopu" poľa — per-objednávkový Playwright zápis (na
  rozdiel od issue 122's hromadného CSV importu, Shoptet nemá hromadný
  mechanizmus pre poznámku objednávky). Nové súbory v `apps/api/src/
  modules/shoptet-writeback/`: `note-block.ts` (čisto textové zlučovanie —
  pripojenie/nahradenie/vymazanie VLASTNÉHO ohraničeného bloku, nikdy
  neprepisuje ručne napísaný text okolo), `admin-login.ts` (zdieľaný login
  helper extrahovaný z issue 122's `playwright-import.ts`, byte-identická
  relokácia), `order-note-select.ts`, `order-note-mark-synced.ts` (PER
  OBJEDNÁVKA, nie dávkovo), `order-note-playwright.ts`, `run-order-note-
  writeback.ts` (orchestrátor).
- Migrácia 0019: `order.comment_updated_at`/`comment_synced_at` (nullable
  timestampy).
- Nová hodinová úloha `orderNoteWritebackJob` (`:55`, mimo `:45`/`:50`).
- Design komentár: https://github.com/zbynekdrlik/forestshop-app/issues/123#issuecomment-5149713234
- Deep review (requesting-code-review skill, subagent): 0 🔴 1 🟡 1 🔵.
  - 🟡 test "zlyhanie na jednej objednávke neprerušuje zvyšok" v skutočnosti
    NIKDY nezacvičil zlyhanie (obe testovacie objednávky vždy uspeli) —
    opravené (`c7fbdf0`): fixture dostala `breakOrder(id)` (stránka bez
    `shopRemark` poľa), nový test dokazuje skutočný partial-failure prípad.
  - 🔵 `OUR_BLOCK_RE` bez `/g` flagu strihne len prvý výskyt nášho bloku —
    zdokumentované ako vedomé (appka nikdy sama neprodukuje druhý blok).
- PR #143.
- Naživo overené na PRESNE jednej objednávke (20261273, `shoptet_order_id
  =59783`): appka → poznámka → spätný zápis (ručne spustený rovnaký kód ako
  naplánovaná úloha, `docker cp` postup) → Shoptet admin potvrdil presne
  náš ohraničený blok v `textarea[name=shopRemark]` → poznámka v appke
  vymazaná → zápis znova → Shoptet pole späť na prázdne. Baseline po teste:
  `order` 534, `order_line` 878, `product_supplier_link_override` 0,
  `product_supplier_override` 0 — presne ako pred testom.
- Testy: 44/44 integration test files (290 testov), unit + web e2e (22/22)
  všetko zelené.
- Issue 123 zavreté ručne (nie cez `Closes #` v PR tele) — rovnaký dôvod ako
  issue 122/120 (acceptancia potrebovala post-deploy živú kontrolu).
- Playbook rozšírený (`.claude/rules/shoptet-writeback.md`): reálny
  objednávkový detail tvar (`shopRemark` textarea, `buttonSaveAndStay`
  odkaz), CRLF→LF normalizácia real Shoptetu (fixture musí kopírovať),
  per-objednávkové mark-synced zdôvodnenie, docker-cp postup potvrdený aj
  pre tento druhý modul.

## Issue 66 — kumulatívne hlásenie o neuložených zmenách ("Na objednanie")

- Design comment PRED prvým kódovým commitom:
  https://github.com/zbynekdrlik/forestshop-app/issues/66#issuecomment-5150002362
  (root cause: jediný `stateError` string zdieľaný 6 zápisovými akciami,
  každé ďalšie zlyhanie prepísalo predchádzajúce; zvolený prístup: keyed
  zoznam zlyhaní `ordersWriteFailures.ts`; zamietnutá alternatíva: portovanie
  legacy `app.js:1093-1240`'s commitSeq optimistickej reconciliation — tento
  app nikdy nezobrazuje zápis ako uložený pred potvrdením servera, takže ten
  pretek tu vôbec neexistuje).
- Nové: `ordersWriteFailures.ts` (RED/GREEN nebolo relevantné — feature, nie
  bug fix, testy pridané v tej istej práci), `OrderWriteFailuresBanner.tsx`,
  `useSupplierEmailEditing.ts` (extrakcia kvôli eslint `max-lines: 400`,
  rovnaký vzor ako `useSupplierMailActions.ts`).
- Testy: `ordersWriteFailures.test.ts` (10), `OrderWriteFailuresBanner
  .test.tsx` (5), `OrdersSection.writeFailures.test.tsx` (1 — dôkaz DVOCH
  nezávislých zlyhaní naraz), 5 existujúcich testov upravených (nová tvar
  bannera namiesto holého stringu), nový Playwright e2e `orders-write-
  failures.spec.ts` (`window.fetch` override cez `addInitScript`, nikdy
  `page.route`, kvôli konzolovej výnimke — zdokumentované v
  `.claude/rules/testing.md`).
- PR #145 (merge 8b17c5c, v0.3.0-dev.87). NEobsahovalo `Closes #66` v
  commit správe ani v tele PR (post-deploy naživo overenie príde AŽ po
  merge) — issue 66 zavreté ručne po overení.
- Naživo overené na produkcii (`forestshop-novy.newlevel.media`) cez
  prepichnutý `window.fetch` (nikdy sa nedotkol reálneho servera): DVE
  nezávislé zlyhania (zmena stavu na dvoch rôznych riadkoch, obj. 20261249 +
  obj. 20261203) sa zobrazili SÚČASNE v banneri ("2 položky"), zamietnuté
  zmeny sa netvárili ako uložené, zatvorenie bannera zmazalo obe naraz,
  konzola bez chýb. Baseline po teste nedotknutý (nič sa reálne neuložilo):
  `product_supplier_link_override|product_supplier_override|order|order_line`
  = `0|0|534|878`, presne pôvodná hodnota.
- Playbook rozšírený: `.claude/rules/orders.md` (kumulatívny zoznam zlyhaní,
  `id` konvencia pre budúce zápisové akcie), `.claude/rules/testing.md`
  (fetch-override technika pre simuláciu zlyhaného zápisu v e2e testoch bez
  porušenia jedinej povolenej konzolovej výnimky), `CLAUDE.md` (rozšírenie
  existujúcej `Closes #N` poznámky — riziko platí aj pre COMMIT správy,
  nielen telo PR, keďže tento repo merguje merge commitom).

- **Bundle: issues 147+148+149+150 — nav odznak / perzistencia dodávateľa /
  ochrana rozpísaného editora / viacriadkový komentár** (PR #154, merge
  `e6cdf94`, v0.3.0-dev.89). Commity `e05995e` (#147: `OrdersRemainingCount
  Context` + `Sidebar`'s generický `badgeCounts` prop), `f3d47c3` (#148:
  `ordersDisplayPreferences.ts` extrahované z `hideResolved`'s existujúceho
  localStorage vzoru), `0e52ee7` (#149: `useDirtyEditorLineIds.ts` +
  `ordersSummary.ts`'s zdieľaný `isLineHiddenByFilter`), `5e7b627` (#150:
  `<input>`→`<textarea>`), `5315fe1` (spojenie do `OrdersSection.tsx`),
  plus testovacie commity `48b8703`/`60a4417`/`2918af5`/`5c5fc99` a
  review-fix commity `62e677e`/`de80851` (deep code review nálezy — 3 🟡 +
  2 🔵, opravené: priamy unit test `isLineHiddenByFilter`, odznak-ov
  `aria-label` prestal niesť doménovo špecifické slovo, dva dokumentačné
  komentáre pre budúci `React.memo` krok).
- Design komentáre PRED prvým kódovým commitom na každom ticket-e:
  issue-comment-5150251505 (#147), -5150253019 (#148), -5150255070 (#149),
  -5150256490 (#150).
- Naživo overené na produkcii (`forestshop-novy.newlevel.media`,
  `vychod@varos.sk`): odznak "Na objednanie: 38" sa objavil po prvej
  návšteve a PREŽIL prepnutie na "Sync zo Shoptetu" (#147); chip
  "BETALOV" ostal aktívny po SKUTOČNOM obnovení stránky (#148); riadok
  (obj. 20261249 / variant 62312) s otvoreným edit panelom odkazu na
  dodávateľa OSTAL viditeľný pri zapnutom "Skryť vybavené", zmizol až po
  zavretí editora (#149); Enter vložil nový riadok bez uloženia (obnovenie
  potvrdilo), Ctrl+Enter uložil viacriadkový text (obnovenie potvrdilo
  perzistenciu) (#150). Všetko vrátené do pôvodného stavu, baseline po
  teste nedotknutý: `product_supplier_override|product_supplier_link_
  override|order|order_line|order_line kde ordered` = `0|0|534|878|0`,
  presne pôvodná hodnota. Všetky 4 tickety zavreté RUČNE (nie cez PR
  `Closes #N`) až PO naživo overení, presne podľa `CLAUDE.md`'s
  poznámky.
- Playbook rozšírený: `.claude/rules/frontend-design.md` (dva NOVÉ
  architektonické vzory — Context pre hodnotu prežívajúcu prepnutie
  záložky; ľahký per-riadkový boolean signál namiesto zdvihnutia celého
  draftu — plus wrapper-harness `useCallback` gotcha), `.claude/rules/
  testing.md` (tag-scoped selector sa rozbije pri zmene tagu prvku;
  Enter-vs-Ctrl+Enter potrebuje SKUTOČNÉ stláčanie klávesov, nie `.fill()`).

## Issues 161, 162, 163 — Na objednanie: stavové tlačidlá, širší editor odkazu, opravená deliaca čiara

Bundle (jedna PR #165, dev→main), rovnaké súbory (`OrderLineRow.tsx`/`app.css`).

- Verzia: `0.3.0-dev.96` (`175895d`).
- **#163** (deliaca čiara nelícuje pod bunkou dodávateľa): RED
  `b4f3c0f` (`orders-layout.spec.ts`'s `nezarovnaneDelice` — zlyhalo až
  44px pri 1280px), GREEN `22224fe` (`app.css`: odstránené `display:flex`
  z `.ord-supplier-merged`, medzera presunutá na `.ord-supplier-assign`'s
  `margin-top`). Skutočná príčina: `display:flex` priamo na `<td>` menilo
  jej box-typ tak, že sa nerozťahovala na výšku riadku ako ostatné bunky.
- **#162** (editor odkazu na dodávateľa príliš úzky, ~94px): RED `5537bbb`
  (`orders-supplier-link.spec.ts` — 51.7px < požadovaných 282px), GREEN
  `6e52339` (`OrderLineRow.tsx`: presunutý do vlastného rozbaľovacieho
  riadku pod hlavným riadkom, `colSpan={9}`; pridané Escape-to-zrušiť).
  Naživo overené: input po fixe 579px.
- **#161** (stav ako 4 tlačidlá namiesto `<select>`u — majiteľova
  explicitná požiadavka): `822c5d6` (feature, jeden commit — nový súbor
  `OrderLineStateButtons.tsx` + `orderLineStateLabels.ts`, 2×2 mriežka
  tlačidiel). Naživo (Playwright proti lokálnemu dev buildu) odhalený a
  opravený CSS Grid `min-width:auto` overflow bug (tlačidlá pretekali do
  susedného stĺpca) — pridané `min-width:0`/`overflow-wrap:break-word`.
- Design komentáre PRED prvým kódovým commitom: issue-comment-5152316395
  (#161), -5152318281 (#162), -5152320251 (#163).
- Validačné komentáre (STEP 0, naživo overené proti v0.3.0-dev.95):
  issue-comment-5152313107 (#161), -5152313661 (#162), -5152314911 (#163).
- CI (`dev` push `822c5d6`): docker-build/version-check/integration/e2e/
  check všetky `success` (run 30710242413). PR #165 mergeable/CLEAN.
- Tickety NEZATVORENÉ cez `Closes #N` — čakajú na živé overenie na
  produkcii, presne podľa `CLAUDE.md`'s poznámky pre tento repo.
- Playbook rozšírený: `.claude/rules/frontend-design.md` — `display:flex`
  priamo na `<td>` rozbíja zarovnanie výšky riadku; CSS Grid `min-width:
  auto` analog k už zdokumentovanej flex `flex-basis` pasci (issue 105);
  presun obsahu do NOVÉHO súrodeneckého `<tr>` rozbíja `within(riadok)`-
  scoped testy (fix: `screen.getByTestId`/Playwright `xpath=./following-
  sibling::tr[1]`); nový testid nesmie zdieľať existujúci `^='...'` prefix.

## 2026-08-01 — #163 (notes-column divider, reopened) + #166 (link-editor silent close)

- Bundled batch (2 issues, same files) — ~106 LoC, well under the gate.
- Version bump `7f85933` (0.3.0-dev.96→.97), first commit.
- STEP 0 validation comments (live Playwright against v0.3.0-dev.96 production):
  issue-comment-5152731928 (#163), -5152733426 (#166).
- Design comments BEFORE first code commit:
  issue-comment-5152734877 (#163) — same `display:flex`-on-`<td>` bug as
  `.ord-supplier-merged` (PR #165), now in `.ord-notes-merged`; fix mirrors
  the established pattern exactly.
  issue-comment-5152736764 (#166) — root cause: `saveLink()` closed the
  editor unconditionally, ignoring the SYNCHRONOUS validation result
  `setSupplierLink` already computed; fix threads a `boolean` return through
  instead of duplicating `validateSupplierLinkUrl` a second time.
- RED→GREEN commits: `9be7508`→`18e6502` (#163, e2e `orders-layout.spec.ts`
  generalized to check ALL `<td>` in a row, not just one hardcoded class);
  `431492b`→`c64d4e7` (#166, new vitest test in
  `OrdersSection.supplierLinkValidation.test.tsx` proving the editor stays
  open with the typed text preserved).
- Local pre-push: lint/typecheck clean, web vitest 38/38 files (283 tests),
  api unit 334 + integration 294, FULL e2e suite (all 9 spec files, 25
  tests) — all green.
- Review comments BEFORE merge: issue-comment-5152866330 (#163),
  -5152867404 (#166) — `/review` + deep `requesting-code-review` subagent
  (git range d127c201..c64d4e7): 0 🔴 0 🟡 0 🔵 both.
- PR #167, CI (both `push` + `pull_request` triggers) all green, mergeable/
  CLEAN. Merged `1715dc3`. Main CI + Deploy both `success`.
- Live post-deploy verification (v0.3.0-dev.97): all 41 order rows have
  every `<td>` bottom-aligned with the row (0px diff, was 19-20.5px on
  notes); invalid link input keeps editor open with typed text + exact
  message, 0 fetch calls. Zero console errors. DB baseline unchanged
  (0|0|535|881|0).
- Tickets closed by hand (`gh issue close`) AFTER live verification, per
  this repo's CLAUDE.md auto-close-trap note — neither PR body nor any
  commit message used `Closes #`/`Fixes #`.
- Playbook: no new gotcha beyond what `.claude/rules/frontend-design.md`
  already documents for the `display:flex`-on-`<td>` class of bug — this
  ticket was a second, predicted instance of exactly that documented
  pattern, confirming the existing entry rather than adding a new one.

## 2026-08-01 — #164 (import internej poznámky e-shopu, obojsmerné)

- Solo ticket (Scope-gate: schema-migration), version bump `a8c327e`
  (0.3.0-dev.97→.98), first commit.
- Design comment BEFORE first code commit: issue-comment-5152963337 — root
  cause (parser nikdy nečítal `shopRemark`), zvolený prístup (surová
  hodnota v DB, odvodená pri dopyte cez `extractForeignShopRemark` — tenký
  wrapper nad existujúcim `mergeShopRemark(raw, null)`), zamietnutá
  alternatíva (ukladať odvodenú hodnotu priamo / prepisovať appkin
  `comment` z importu).
- STEP 0 validation comment: issue-comment-5152965388 (grep na main HEAD
  1715dc3 potvrdil 0 skutočného kódu čítajúceho `shopRemark`).
- RED→GREEN reťaz (7 párov): `extractForeignShopRemark` (note-block.ts) →
  parser (`mapOrderRow`) → `ingest.ts` storage+refresh (integračný test
  proti reálnemu Postgresu, RED overené `git stash` na `queries.ts`/
  `ingest.ts`) → `queries.ts` HTTP expozícia → `OrderLineRow.tsx` UI
  vykreslenie. Plus explicitný "kruh sa uzavrie" test (comment prežije
  re-import nedotknutý, shop_remark sa AJ TAK osvieži, v tom istom teste).
- 17 existujúcich fixtúrových `OrderLine` objektov (vitest test súbory)
  dostalo explicitné `shopRemark: null` (zavedená konvencia repa — Python
  regex insert za `remark: ...,`).
- E2E: objednávka 9001 (`scripts/e2e-setup.ts`) dostala reálnu hodnotu
  `shopRemark`, `orders.spec.ts` ju overuje. Row-height strop v
  `orders-layout.spec.ts` zdvihnutý 100px→115px (naživo namerané 108.5px —
  tretí stĺpcovaný riadok v zlúčenej bunke Poznámky, nie regresia
  zalomenia vstup+tlačidlo, tá asercia sa nemenila).
- Fixtúra `orders-sample.csv` (order 20300001) dostala reálnu `shopRemark`
  hodnotu — presný postup z `.claude/rules/orders.md` (csv.reader + ručné
  poskladanie riadku, žiadny `csv.writer` nad celým súborom).
- PR #168, CI (push aj pull_request) — pozri completion report pre finálny
  stav.
- Playbook: nový bod v `.claude/rules/orders.md` — 3-krokový checklist pri
  pridávaní ĎALŠIEHO poľa na `OpenOrderLine` (surové+odvodené polia,
  17-súborová fixtúrová konvencia, row-height strop treba pri KAŽDOM
  ďalšom stĺpcovanom riadku v "Poznámky" bunke naživo premerať).

## 2026-08-01 — #169 (OUR_BLOCK_RE — druhý výskyt bloku + CRLF separátor)

- Solo ticket (Scope-gate: cross-cutting), version bump `4113e34`
  (0.3.0-dev.98→.99), first commit.
- Design comment BEFORE first code commit: issue-comment-5153199372 — root
  cause (`OUR_BLOCK_RE` bez `/g`, `.replace()` odstráni len prvý výskyt;
  prefix `\n{1,2}` nesedí na `\r\n`), zvolený prístup (samostatný
  `OUR_BLOCK_RE_GLOBAL` len pre `.replace()`, pôvodný `OUR_BLOCK_RE` bez
  `/g` ostáva pre `hasOurBlock`'s `.test()`), zamietnutá alternatíva
  (pridať `/g` na zdieľaný objekt použitý aj v `.test()` — zamietnuté pre
  stavový `lastIndex` globálnych regexov, ktorý by ticho zaviedol nový bug
  do opakovaných `hasOurBlock` volaní).
- STEP 0 validation comment: issue-comment-5153200250 (obe slabiny
  reprodukované priamo v Node REPL proti kódu na `dev` `4113e34`).
- RED→GREEN: 3 nové testy v `note-block.test.ts` (dva bloky odstránené
  OBIDVA cez `mergeShopRemark`, CRLF separátor odstránený spolu s blokom,
  `extractForeignShopRemark` s dvomi blokmi nikdy nezobrazí druhý ako
  cudzí text) — RED overené proti pôvodnému kódu (`b8c0cc1`), GREEN po
  fixe (`a47582b`). Review comment: issue-comment-5153237481 (0🔴 0🟡 0🔵).
- PR #170, CI (push aj pull_request) zelené, mergeable+clean → merged
  `21a5a3d`.
- Main CI aj Deploy monitorované po merge — Deploy prvýkrát zlyhal
  (`failed to Lchown ... no such file or directory` počas extrakcie
  vrstvy), diagnostikované ako TRANSIENTNÝ race so súbežným CI jobom na
  tom istom self-hosted dev2 runneri (potvrdené koreláciou
  `journalctl -u docker` časových pečiatok s `gh run list`) — nie
  obsahová chyba image. `gh run rerun --failed` prešiel na prvý pokus,
  žiadny iný job vtedy nebežal. Detail pridaný do `.claude/rules/deploy.md`.
- Live overené: `/api/version` = `0.3.0-dev.99`/`21a5a3d`, dashboard DOM
  `v0.3.0-dev.99`, objednávky (`?tab=orders`) vykreslené 41 riadkov, 0
  console errors/warnings. DB baseline nezmenený (`0|0|535|881`).
- Playbook: nový bod v `.claude/rules/deploy.md` — súbežný CI job na tom
  istom self-hosted runneri ako `deploy` job je ĎALŠÍ pozorovaný spúšťač
  tej istej "failed to extract layer" triedy chýb; diagnostický vzor
  (korelácia `journalctl -u docker` s `gh run list` časovými pečiatkami)
  pridaný pre budúci podobný nález.

## Issue 171 — poznámku zákazníka pod text produktu (2026-08-02)

- Design comment (issue-comment-5158732415) PRED prvým commitom: koreň
  problému (`remark` v zlúčenej `td.ord-notes-merged`, ďaleko od produktu,
  ktorého sa týka), zvolený prístup (presunúť LEN `remark-cell` div do
  produktovej `<td>` ako sibling `<div>` pod obaleným menom, žiadny
  `display:flex` na `<td>`, issue 163's poučenie), zamietnutá alternatíva
  (len vizuálne prepojiť, nechať v POZNÁMKY — zamietnuté, ticket žiada
  fyzické premiestnenie).
- STILL-VALID komentár (issue-comment-5158733610): overené proti `dev`
  (`df4e607`), remark stále v `ord-notes-merged`, žiadny neskorší PR to
  nepresunul.
- Implementácia: `OrderLineRow.tsx` (produktová `<td>` obalí meno do
  `.ord-product-name` + rovnaký `remark-cell-<id>` div ako sibling; POZNÁMKY
  `<td>` stráca svoj bývalý prvý blok), `app.css` (`.ord-remark` dostáva
  `font-size: var(--fs-text-xs)`, `margin-top` presunutý z
  `.ord-shop-remark-cell` na `.ord-remark-cell`).
- Testy: `OrderLineRow.remarkCell.test.tsx` + `OrdersSection.test.tsx` —
  nové assercie na DOM umiestnenie (remark v tej istej `<td>` ako meno
  produktu, inej než POZNÁMKY). `orders-layout.spec.ts` živo prehodnotilo
  strop výšky kompaktného riadku — throwaway debug meranie (`console.log`
  vyskok, revertnuté) ukázalo 98.19px (predtým ~108.5px so všetkými tromi
  poznámkami v jednej bunke) — strop znížený 115px→105px, plus nová
  kontrola placement + font-size odlíšenia. Commit `991f7c1`.
- Lokálne overené PRED pushom: web unit 39/39 súborov (287→289 testov po
  pridaní), api unit 22/22 (345 testov, backend nedotknutý), web e2e
  25/25 (vrátane `orders-layout.spec.ts`), `pnpm lint` + `pnpm typecheck`
  čisté.
- Review comment (issue-comment-5158838610): vlastný /review pass, 0🔴 0🟡,
  1 drobný 🔵 self-note (empty `remark-cell` div nesie `margin-top` aj bez
  obsahu — rovnaký ustálený vzor ako mala `.ord-shop-remark-cell` predtým,
  živo zmeraná výška riadku ho nepreukazuje ako problém).
- PR #174 — `Closes #171` ZÁMERNE nepoužité (ticket má live post-deploy
  overenie ako akceptačnú podmienku, `.claude/rules/CLAUDE.md`'s auto-close
  poučenie) — CI (push run 30753998616 aj PR-triggered run 30754149804)
  všetko `success`, PR `MERGEABLE`+`CLEAN` → merged `d5ccd06` (merge
  commit).
- Main CI (run 30754277925) aj Deploy (run 30754277901) monitorované po
  merge — obe `success`.
- Live overené (Playwright MCP): `/api/version` = `0.3.0-dev.100`/
  `d5ccd06`. Riadok "Nabíjačka NITECORE UM4" (objednávka 20261063) —
  `remark-cell.closest('td') === productDiv.closest('td')` → `true`;
  `.ord-notes-merged` (35 živých riadkov) neobsahuje žiadny `remark-cell`;
  font-size 12px (poznámka) vs 13px (meno produktu); zmeraná výška riadku
  85px. Konzola: 0 chýb/varovaní. DB baseline nezmenený (overrides 0|0,
  order/order_line 535→536 / 881→882 normálnym importom).
- Issue #171 zavretý s dôkazom (issue-comment-5158877599). Discord karta
  odoslaná (`notify --run-card`, `sent`).

## Issue 176 — Nedostupné tovary (informovanie zákazníka e-mailom, s návrhom náhrady)

- Design comment (issue-comment-5160403045) + validated comment
  (issue-comment-5160403902) pred prvým kódovým commitom (verzia bump
  `c4494e4` bol PRVÝ, feature commit `cdb5aa5` až po nich).
- Zoskupenie podľa variantu nad existujúcim `order_line.state = 'nedostupne'`
  (žiadny nový flag), spárovanie s otvorenými objednávkami cez
  `listOpenStatusNames`. ŽIADNY scheduler/`enabled` — vždy živý DB dopyt.
- Nová migrácia `0023_steep_smasher.sql`: `product.related_codes` (text[],
  nullable), tabuľka `nedostupne_state` (dedup, plain-text kľúčovaná ako
  `order_reminder_state`/`posta_uncollected_state`).
- Deep code review pred mergom (PR #182, issue-comment-5160705285) našiel 1
  Important (server-side vynútenie povinného náhľadu chýbalo) + 2 Minor
  (chýbajúci `requireSameOrigin()` na `/preview`; scheduler.md registry bez
  005/006) — všetky opravené commitom `a491963` PRED mergom (jednorazový
  `previewToken`, 15 min TTL, in-memory rovnaký vzor ako
  `login-rate-limit.ts`). Samostatný self-review nálezmi ešte skôr pridal
  `NEDOSTUPNE_SEND_LOCK_KEY` (787_878_006, commit `77cbc38`) — bez neho by
  dva súbežné klik-y na ten istý (objednávka, variant, typ) mohli poslať
  e-mail dvakrát.
- Testy: `logic.test.ts` (9), `preview-tokens.test.ts` (6), `map-row.test.ts`
  relatedCodes rozšírenie, `nedostupne-run.integration.test.ts` (12,
  vrátane deterministického `pg_try_advisory_lock` súbežnostného testu),
  `nedostupne-http.integration.test.ts` (11), `NedostupneSection.test.tsx`
  (9), `nedostupne.spec.ts` (e2e, fixtúra "9008"/variant "40287" s reálnou
  `relatedProduct=60297` z katalógovej fixtúry). `orders.spec.ts` prvý test
  aktualizovaný (nová 'nedostupne' fixtúra pridáva 1 riadok do "(bez
  dodávateľa)" a novú "Nedostupné 1" vetvu do súhrnu).
- CI (push 30770647458 aj PR-triggered 30770649121) `success` → PR #182
  merged `2242449` (merge commit). Main CI (30770803484) + Deploy
  (30770803482) `success`.
- Live overené (Playwright MCP, `vychod@varos.sk`): `/api/version` =
  `0.3.0-dev.107`/`2242449`. `?tab=nedostupne` sa načíta, 0 console chýb.
  BCC upozornenie zobrazené správne (NEDOSTUPNE_BCC_EMAIL nie je na dev2
  nastavené — fail-closed funguje naživo), "mail not configured" NEzobrazené
  (MAIL_HOST JE nastavené). Prázdny zoznam (nikto zatiaľ nemá nedostupný
  riadok) korektný. Zámerne som NEMUTOVAL žiadny reálny zákaznícky riadok
  naživo — funkčná správnosť zoskupenia/dedup/tokenu je preukázaná plnou
  integračnou + e2e sadou nad rovnakou schémou.
- Nový playbook súbor `.claude/rules/nedostupne.md` + router riadok v
  `CLAUDE.md`. Issue #176 zavretý s dôkazom. Discord karta odoslaná.

## Issue 185 + 184 (2026-08-03, PR #186)

- Issue 185 — "Automatizácie" nav folder: moved posta-uncollected/
  order-reminder/nedostupne from `HIDDEN_TABS` into a new visible `NAV`
  folder (`apps/web/src/nav.ts`). Commits `aec5e3a` (main change),
  `4419a77`/`cd73b45` (self-review fixes). Added `badgeStatus` prop to
  `Sidebar.tsx` (Beží/Zastavené pill, same pattern as issue 147's
  `badgeCounts`), fetched by `App.tsx` from the two existing status
  endpoints. Filled 4 missing `JOB_LABELS` entries. Removed the now-
  duplicate `<h2>` from the three screens (Topbar's `<h1>` now renders for
  them). Tests: `nav.test.ts`, `Sidebar.test.tsx`, `schedulerLabels.test.ts`
  (new), `nav.spec.ts` e2e (updated to 3 folders/5 tabs).
- Issue 184 — hourly catalog-import: `catalogImportJob` schedule
  `daily 01:00` → `hourly :20 UTC` (commit `6fb74cd`). Measured production
  duration first (19.5-22.9s/run, 6 samples) before deciding — negligible
  load. Disk check found dev2 root fs at 98% (~25GB free); shortened
  `pruneRawExportsJob`'s default retention 30→14 days (+ CLI's `KEEP_DAYS`)
  to bound the extra raw-snapshot growth from hourly imports. New tests:
  `catalogImportJob` schedule-shape test + a behavioral test proving the
  DEFAULT retention (not just an explicit override) changed to 14 days.
- Self-review (subagent dispatch limit reached this session — reviewed
  manually instead) found and fixed: a dead CSS class targeted via a nested
  selector instead of directly; a genuine e2e flakiness risk (hardcoded
  pill text raced against posta-uncollected.spec.ts/order-reminder.spec.ts
  toggling the same shared singleton row across concurrent Playwright
  workers — relaxed to accept either valid state, matching this file's
  existing discipline for the badge-count assertion); two doc/comment
  precision fixes (timing claim, stray markdown-bold in a .ts comment).
- CI (push+PR runs, multiple cycles after review fixes) all green. PR #186
  merged `195c831` (merge commit, dev→main). Main CI `30806516180` success.
  Deploy `30806516186`: FIRST attempt failed on the documented transient
  containerd `failed to extract layer ... Lchown` error (`.claude/rules/
  deploy.md`) — confirmed no concurrent runner job, reran once, succeeded.
- Live verified (Playwright MCP, `vychod@varos.sk`): `/api/version` =
  `0.3.0-dev.109`/`195c831`. Automatizácie folder visible with all 3 items,
  correct Zastavené pills, no pill on Nedostupné tovary. "História behov"
  shows translated job names. **Hourly catalog-import fired live** at
  10:51:55 UTC with NO manual trigger (24s duration) — visible in the Sync
  screen and history table within the hour, as required. Zero console
  errors. Production baseline unchanged (0|0|0).
- Both issues closed with evidence, both Discord completion cards fired.

## Batch: issue 223 (huntingshop.eu pätičková veta) + issue 225 (odimon.sk klamlivé JSON-LD) — 4. 8. 2026

- Version bump `42c87c0` (0.3.0-dev.129 → .130). RED `f1989aa` (fixtúry z
  reálnych stránok + failing testy pre oba tickety). GREEN `9ad65e0`:
  `TRUSTED_TEXT_HOSTS` nahradené `TEXT_AVAILABILITY_RULES` (per-host výrez +
  čo znamená chýbajúci výrez), pridané `VISIBLE_AVAILABILITY_RULES` (odimon.sk
  krížová kontrola JSON-LD vs viditeľná dostupnosť pri produkte).
  `wetland.sk`/`trigona.sk` zámerne stratili textovú úroveň (žiadny overený
  výrez) — sledované v novo založenom issue 230.
- Code review (`superpowers:requesting-code-review`, nezávislý subagent)
  našiel 1 Important nález (odimon.sk `availabilityText` sa odvodzovala z
  náhodnej "druhej zatváracej `</span>`", krehké pri ďalšom vnorenom
  prvku) — opravené `0f430f7`, pridaný regresný test s vnoreným počtom
  kusov. Aj playbook (`.claude/rules/supplier-stock.md`) aktualizovaný v
  tom istom commite (starý odkaz na odstránenú `TRUSTED_TEXT_HOSTS`).
- PR #229 (bundle, closes issue 223 + issue 225 bez `Closes #N` v tele/
  commitoch — tento repo má pascu s predčasným auto-close, pozri CLAUDE.md).
  CI zelené (2 cykly — pred aj po review-fix commite), mergeable/clean,
  merge `671c464a`. Main CI + Deploy zelené.
- Live overené priamo na dev2 kontajneri (`docker exec forestshop-app-1`),
  nasadený `parsePage` spustený proti REÁLNYM živým stránkam: huntingshop.eu
  skladom produkt → `available` (nezmenené); pôvodná URL vypredaného
  ruksaku (dnes redirect na homepage s tou istou pätičkovou vetou) →
  `unavailable` (predtým by bolo `available` — bug potvrdene opravený);
  odimon.sk konfliktná stránka → `unknown` (predtým `available` z JSON-LD).
  `/api/version` = `0.3.0-dev.130`/`671c464a`. Produkčné počty
  (`huntingshop.eu` 310/210, `odimon.sk` 182/63) sú zatiaľ NEZMENENÉ —
  scraper prehodnocuje odkaz až po 20 h, skutočný rozpad uvidíme po
  najbližšom nočnom behu; obe issue majú komentár s vysvetlením a čakajú
  na doplnenie čísla.
- Oba tickety zavreté ručne (223, 225) s dôkazom; issue 230 (wetland.sk/
  trigona.sk vlastný výrez) založené ako follow-up. Oba Discord run-card
  odoslané.

- issue 224 (dostupnosť za veľkosť, nie za celý odkaz): version bump
  `8be3032` (0.3.0-dev.132). RED `fdba969` (`parse.test.ts`:
  `parseSizeAvailability`/`matchSizeLabel` fixtúry lasting.eu). GREEN
  `120f10d` (per-veľkostný extraktor + tolerantné párovanie), `c11f438`
  (schéma `(link,size_label)`, migrácia `0029_supplier_stock_size_label.sql`,
  `run.ts`/`restock/queries.ts` prepojenie, web UI stĺpec Veľkosť).
  PR #232, code review (2 Important fixed same PR, `a2f558b`: db.transaction
  na zápis, výrez veľkostí ohraničený popiskom "VELIKOST" — zdieľaná trieda
  na 3 skupinách). Merge `9ddf243`. Post-deploy overenie odhalilo, že
  `MAX_PAGE_BYTES` (2 MB, issue 212) orezával reálnu BONY stránku (2,18 MB,
  whitespace-bloat v dodávateľovej šablóne) skôr, než dočítal veľkostný
  zoznam → PR #233 (RED `ed27f6a`/GREEN `042529a`, MAX_PAGE_BYTES 2MB→5MB),
  merge `463a427`. Playbook doplnený PR #234 (`1ddfc76`), merge `ee6effc`.
  Naživo overené proti nasadenej appke (0.3.0-dev.134): `16707/L-X` →
  `unavailable` (spárované na dodávateľovo "L/XL"), `16710/XS` → `unknown`
  (dodávateľ tú veľkosť nemá). Issue zavreté ručne s dôkazom, Discord
  run-card odoslaná.

- issue 230 (wetland.sk/trigona.sk textová dostupnosť po issue 223):
  version bump `b135fd8` (0.3.0-dev.136). RED `8f406c5` (`parse.test.ts`:
  trigona.sk StockCountText fixtúry, oba stavy). GREEN `8ec6c51`
  (`trigonaStockRegion` — farba `#00b020`/`#024bbd` → "skladom"/"vypredané",
  `whenRegionMissing: "unknown"`; wetland.sk zámerne BEZ pravidla — 67+
  naživo overených stránok malo vždy len "success" štítok, žiadny overený
  vypredaný príklad). PR #236, code review (`requesting-code-review`,
  independent live fetch verify): 1 Important (extractRegion nedostáva url,
  filed #241, cross-cutting, neopravené v tomto PR) + 2 Minor (regex
  rigidita, chýbajúca negatívna host assercia — oba opravené `3d43e1b`).
  Merge `f0b56e5`. Post-deploy overené proti nasadenej appke
  (0.3.0-dev.136): živé URL → `source: json_ld` (JSON-LD dnes pokrýva
  takmer všetko), trimmed fixtúry bez JSON-LD → `source: text`, obe
  polarity aj chýbajúci štítok správne. Issue zavreté ručne s dôkazom,
  Discord run-card odoslaná.

- issue 226 (krížová kontrola nášho stavu proti Shoptetovej dostupnosti z
  feedu google.xml): version bump `1d6c36a` (0.3.0-dev.138). RED `913b800`
  (parse.test.ts g:availability extrakcia, nový feed-cross-check.test.ts,
  nový catalog-feed-cross-check.integration.test.ts, restock-run.integration
  .test.ts Z1/Z2/Z3, RestockSection.test.tsx karta, e2e PREP-2 + catalog.spec
  .ts počty 36→37 — všetko zámerne padajúce, feature ešte neexistovala).
  GREEN `3d8204e` (migrácia 0030 `shop_product_url.availability`,
  `parseShopFeed`/`runShopFeed` ukladajú g:availability, nový
  `modules/catalog/feed-cross-check.ts` — `compareStateToFeed` čistá funkcia
  + `findFeedStateConflicts` naživo z DB, nikdy perzistovaná snímka +
  `logFeedConflictsAfterImport` mimo hlavnej transakcie; `restock/queries.ts`
  vylúči kandidáta keď feed hovorí "in stock"; `/api/restock` +
  RestockSection.tsx nová karta s počtom aj zoznamom; scripts/e2e-setup.ts
  doplnilo shop_product_url do TRUNCATE zoznamu — chýbalo tam od issue 220).
  PR #243, code review (`superpowers:requesting-code-review`, nezávislý
  subagent): 0 Critical, 2 Important (test-hygiene: `ourUrl: null` mock
  proti nenulovej schéme, chýbajúci test na prepis dostupnosti na null pri
  strate značky) — obe opravené `5ef9923`. Merge `e658a7b`. Deploy prvý
  pokus zlyhal na známom transientnom containerd/overlayfs jave
  (`.claude/rules/deploy.md`, "failed commit on ref ... no such file or
  directory") — `gh run rerun --failed` prešiel na druhý pokus. Naživo
  overené proti nasadenej appke (0.3.0-dev.138): dočasný zásah do
  `shop_product_url.availability` na reálnych variantoch (60031/XXL,
  61276/M) ukázal kartu rozporov aj vylúčenie z kandidátov presne podľa
  očakávania, oba vrátené na pôvodné `null` po overení (Pripravených na
  prepnutie späť na 2, Rozpory: Žiadne). Issue zavreté ručne s dôkazom,
  Discord run-card odoslaná. Playbook doplnený v GREEN commite
  (`.claude/rules/shop-feed.md`, `.claude/rules/supplier-stock.md`).

- issue 237 (prehľad e-shopu + súhrn o objednávaní nad zoznamom "Na
  objednanie"): nový `orders.total_price_with_vat numeric(12,2)` (migrácia
  0031), extrahovaný v `parser.ts` cez zdieľaný `catalog/money.ts`'s
  `parseDecimalComma`, vždy osviežený pri re-importe (rovnaká rodina ako
  `status_name`/`remark`/`shop_remark`). Nový modul `orders/overview.ts`
  (Europe/Bratislava deň/týždeň/mesiac hranice cez znovupoužité
  `parseShopLocalDateTime`, BigInt-cent-presný súčet peňazí,
  `getOrdersDashboardOverview` číta VŠETKY objednávky bez ohľadu na
  `status_name`) + nová trasa `GET /api/orders/overview` (registrovaná
  PRED `:id`). Frontend: `OrdersOverviewTiles.tsx` nad `OrdersToolbar` —
  "Prehľad e-shopu" (vlastný fetch) + "Súhrn o objednávaní" (čisto zo
  `suppliers`, nové `countAffectedOrders`/`oldestWaitingPlacedAt`/
  `formatOrderCount` v `ordersSummary.ts`). 14 existujúcich
  `OrdersSection*`/`OrderLineRow*.test.tsx` súborov doplnených o mock
  `fetchOrdersOverview`. Testy: `overview.test.ts` (13),
  `orders-overview.integration.test.ts` (7),
  `orders-ingest-total-price.integration.test.ts` (2, vydelené aby
  `orders-ingest.integration.test.ts` neprešlo cez eslint `max-lines:
  400`), `ordersSummary.test.ts` (+21), `OrdersOverviewTiles.test.tsx` (5),
  nový e2e `orders-overview.spec.ts` (porovnáva proti `/api/orders/open`
  naživo, nie hardcoded čísla). PR #244, code review
  (`superpowers:requesting-code-review`, nezávislý subagent, sám si
  spustil celú lokálnu sadu vrátane 6 zdieľaných e2e specov): 0 Critical, 2
  Important (storno-objednávky otázka pre naživo overenie — zdokumentované
  v `.claude/rules/orders.md`; playbook zápis — doplnený), 1 Minor
  (slovenské skloňovanie "1 objednávok" → oprava `formatOrderCount`, paucal
  tvar). Merge `227f94d`. Naživo overené proti Shoptet administrácii
  (`/admin/statistiky-objednavek-a-obratu/`, filter "Dnes") — PRESNÁ ZHODA:
  8 objednávok, 446,90 € oboma stranami. Issue zavreté ručne s dôkazom,
  Discord run-card odoslaná. Playbook doplnený (`.claude/rules/orders.md`).

- issue 238 (Nedostupné tovary prepracované podľa majiteľovho nákresu):
  automatický "Náhrada:" návrh (`product.relatedCodes`, Shoptetovo
  "súvisiace produkty") zrušený, majiteľ ho zamietol ako blbosť. Nová
  tabuľka `nedostupne_replacement_link` (migrácia 0032, `variant_code`
  PLAIN bez FK — rovnaká konvencia ako `nedostupne_state`, ŽIADNY unique
  index — viac riadkov = viac ručných liniek na tovar, zoradené podľa
  vloženia) + nový modul `modules/nedostupne/replacement-links.ts` +
  `POST`/`DELETE /api/nedostupne/replacement-links[/:id]` (rovnaké
  oprávnenie ako `/send`, URL validovaná http(s)-only + formula-guard
  rovnako ako existujúci `orderLineSupplierLinkBody`). Prekliky: názov
  produktu → náš e-shop (`shop_product_url`, `null` = neaktívny, ŽIADEN
  vyhľadávací fallback na rozdiel od `restock` obrazovky — ticket to žiadal
  explicitne), kód produktu → dodávateľ (zdieľaná
  `resolveEffectiveSupplierLink`, rovnaká funkcia ako "Na objednanie").
  E-mail (`buildAlternativeEmail`) teraz berie holé URL priamo (label = url,
  appka nepozná názov ručne vloženého odkazu). `mail-templates/samples.ts`'s
  live-data náhľad prepnutý na vzorku z novej tabuľky namiesto
  `product.relatedCodes`. TDD: `[red]`/`[green]` pár na `logic.test.ts`
  (`buildAlternativeEmail`), + integračné testy pre nový modul + HTTP
  trasy + e2e (pridanie/zmazanie odkazu, prežitie reloadu, oba prekliky,
  obsah preview e-mailu). `product.related_codes` stĺpec/import v katalógu
  ostáva nedotknutý (cross-cutting, mimo scope) — teraz mŕtvy kód, follow-up
  na odstránenie: issue 245. Code review (self-audit + nezávislý
  `superpowers:requesting-code-review` subagent): 0 Critical, 0 Important,
  2 Minor (zastaraný komentár v teste — opravený; chýbajúci dedikovaný test
  pre "ten istý variant vo viacerých objednávkach" — vyhodnotené ako
  nízkoriziková a neoprávnená samostatná práca). PR #246, merge `db2a6b0`.
  Naživo overené na `forestshop-novy.newlevel.media` (v0.3.0-dev.140) proti
  REÁLNYM produkčným dátam (8 skutočných nedostupných tovarov): žiadny
  automatický návrh nikde, ručný odkaz pridaný/prežil reload/objavil sa v
  preview/zmazaný (upratané), všetky tri prekliky fungujú na reálnych
  produktoch, jeden reálny produkt bez známej e-shop adresy ("Ocieľka
  Victorinox 7.8213 - 20cm") správne ostal neaktívny plain text namiesto
  vymyslenej adresy. Konzola čistá. Issue zavreté ručne s dôkazom, Discord
  run-card odoslaná. Playbook doplnený (`.claude/rules/nedostupne.md`,
  `.claude/rules/mail-templates.md`).

## 2026-08-04/05 — #239 (Eshop → Párovanie produktov — chýbajúce dodávateľské linky)

- Solo ticket. Version bump `8fdf23e` (0.3.0-dev.140→.141), first commit.
- Design comment BEFORE first code commit:
  https://github.com/zbynekdrlik/forestshop-app/issues/239#issuecomment-5184875036
  — rozhodnutie: SAMOSTATNÁ nová obrazovka, nie rozšírenie skrytej `pairing`
  záložky (tá je variant-kľúčovaný stavový automat pre budúce automatické
  párovanie s dodávateľom, #46/#48, nezapisuje do Shoptetu vôbec — odlišný
  dátový model aj downstream konzument od tohto ticketu).
- Backend `4b88111`: `apps/api/src/modules/product-links/queries.ts`
  (`listProductLinks` — JS-side efektívna linka cez existujúce
  `resolveEffectiveSupplierLink`, rovnaký vzor ako `supplier-stock/run.ts`),
  `product-links-routes.ts`, refaktor `supplier-link-assignment.ts`
  (zdieľané `upsertProductSupplierLink` jadro medzi `lineId`-cestou #121 a
  novou `productKey`-cestou, zúžený `UpsertExecutor` tx-parameter presne
  podľa `.claude/rules/database.md`), zdieľaná zod schéma `supplierLinkUrlBody`
  (odstránená duplicita v `orders-routes.ts`). Integračné testy:
  `product-links-http.integration.test.ts` (9 testov).
- Frontend `fb7530d`: `SupplierLinksSection.tsx` + `supplierLinksApi.ts`,
  nová VIDITEĽNÁ záložka v `nav.ts` (skupina Eshop, `supplier-links`),
  `nav.spec.ts`/`nav.test.ts` prepočítané na 10 záložiek, nový e2e
  `supplier-links.spec.ts` (vlastný izolovaný účet `e2e-parovanie@…`),
  fixtúry vyčlenené do `scripts/e2e-fixtures-product-links.ts` (eslint
  max-lines). `df4c288`: odstránený duplicitný `<h2>` (viditeľná záložka
  dostáva titulok od Topbar-u, presne ako issue 185's poznámka v nav.ts
  žiadala), `catalog.spec.ts` počty posunuté (37→39, 7→9) — nové e2e
  fixtúrové produkty zdieľajú katalógový snapshot.
- Nesúvisiaci CI-blokujúci nález opravený v tomto PR (`49f67d3`):
  `orders-overview.integration.test.ts` mal pevný dátumový literál ako
  "dnes" (2026-08-03/04), trasa počíta skutočný `new Date()` — pri
  prechode kalendárneho dňa počas vývoja test spoľahlivo spadol. Fix:
  hranica prepočítaná pri behu testu cez existujúci
  `computeBratislavaPeriodBoundaries` — poučenie pre ĎALŠÍ podobný test:
  hardcoded "dnes" literál oproti route, čo číta skutočný čas, je časovaná
  bomba, nie jednorazová fixtúra.
- Code review: vlastný `/review` prechod + nezávislý
  `superpowers:requesting-code-review` subagent (base `db2a6b0` → head
  `df4c288`) — obidva 0 Critical, 0 Important; len neblokujúce poznámky
  (stránkovanie nad 50 riadkov ako existujúci vzor `PairingSection`,
  `variantCount` nefiltrovaný podľa stavu ako existujúci `catalogStats`
  vzor). PR #247, merge `6742cc5`.
- Naživo overené na `forestshop-novy.newlevel.media` (v0.3.0-dev.141):
  zoznam ukázal reálnych 2301 produktov bez linky (zodpovedá živému
  rozboru pri validácii ticketu: 4542 produktov, 2241 s rozpoznateľnou
  linkou, 2 override). Doplnenie/oprava vyskúšaná na REÁLNOM produkte
  ("01 Detské tričko - Jeleň ručiaci") — keďže adresa sa nikdy nedopĺňa
  odhadom, na overenie bola použitá JEHO VLASTNÁ už existujúca linka (zo
  Shoptet-ovho `internalNote`, prefill cez "Upraviť"), nie vymyslená
  hodnota. Stav sa zmenil "⏳ Uložené, čaká na odoslanie" → po ručnom
  spustení `shoptet-writeback` jobu (dokumentovaný postup,
  `.claude/rules/shoptet-writeback.md`, výsledok `{"status":"ok",
  "productCount":1,"rowCount":5}`) → "✅ Odoslané do Shoptetu" — `runShoptetWriteback`
  potvrdzuje úspech spätným čítaním Shoptet-ovho vlastného Logu, teda
  reálny dôkaz, že linka dorazila do Shoptet administrácie. Konzola čistá
  počas celého overovania. Issue zavreté ručne s dôkazom, Discord run-card
  odoslaná.

## Issue 240 — Eshop → Vyhľadať (nový, 2026-08-05)

- Návrh (pred prvým commitom): dve oddelené polia `GET /api/search`
  (produkty ILIKE kód/názov/dodávateľ/externalCode, objednávky ILIKE
  číslo/meno/e-mail, žiadna umelá relevance logika) + nová READ-ONLY
  `GET /api/product-detail/:productKey` (všetky varianty + efektívna linka
  + adresa u nás + dostupnosť u dodávateľa). Editácia linky ide cez
  EXISTUJÚcu `POST /api/product-links/:productKey` (#239) — žiadna nová
  zapisovacia cesta. Zamietnutá alternatíva: rozšíriť skrytú `CatalogPage`
  namiesto novej záložky (riziko regresie `catalog.spec.ts`, zliatie dvoch
  odlišných úloh). Komentáre na tickete #240 (validácia + návrh + review).
- TDD: `search-http.integration.test.ts` (11 testov), `product-detail-http
  .integration.test.ts` (8 testov), `SearchSection.test.tsx` (10 testov),
  `search.spec.ts` (e2e, find→open→edit→save→verify). `pnpm test` (970),
  `pnpm test:integration` (472), `pnpm --filter @forestshop/web e2e` (36) —
  všetko zelené pred pushom.
- Nová záložka "Vyhľadať" v `nav.ts` kolidovala substring-om s existujúcimi
  `getByRole("button", {name:"Hľadať"})` v `catalog.spec.ts` (Sidebar je
  vždy namountovaný) — opravené `{exact:true}` na strane existujúceho
  (užšieho) locatora, zapísané do `.claude/rules/testing.md`. `catalog
  .spec.ts`'s pevné počty variantov posunuté +1 (nový sellable produkt
  e2e fixtúry). `nav.test.ts`/`nav.spec.ts` na 11 záložiek.
- `superpowers:requesting-code-review` (base `ca4c4fd` → head `f8b330e`):
  0 Critical, 0 Important, 2 Minor (žiadny integračný test priamo pre
  `escapeLikePattern` cez `/api/search`; kozmetické preformátovanie
  jedného riadku v `e2e-setup.ts` kvôli eslint `max-lines`). PR #248,
  merge `46a87eb8`.
- Naživo overené na `forestshop-novy.newlevel.media` (v0.3.0-dev.142):
  hľadanie podľa časti názvu ("OPASOK LYNX"/"Nohavice") našlo reálne
  produkty, detail otvoril 6 variantov "01 Nohavice ALASKA YUKON" so
  skutočnými cenami/skladom; efektívna linka produktu "OPASOK LYNX"
  (`https://www.tthunt.sk/...`) sa zhodovala s "Párovanie produktov"'s
  zobrazením toho istého produktu. Úprava (na tú istú hodnotu, aby sa
  nezmenili reálne dáta) prešla, stav sa zmenil na "⏳ Uložené, čaká na
  odoslanie". Hľadanie podľa reálneho čísla objednávky ("20261296") našlo
  presne tú objednávku (meno/e-mail zákazníka zámerne nezverejnené, verejný
  repozitár), žiadny produktový blok sa nezobrazil. Konzola čistá počas
  celého overovania. Issue zavreté ručne s dôkazom, Discord run-card
  odoslaná.

## 2026-08-05 — #227 (Scraper — 5 nových domén + vylúčenie vlastného e-shopu)

- Solo ticket. Overenie naživo (produkčná DB): `supplier_stock` 2305 riadkov,
  629 `unknown` (mierne viac než ticket's 601 — nové odkazy medzičasom).
  Design comment PRED prvým commitom:
  https://github.com/zbynekdrlik/forestshop-app/issues/227#issuecomment-5186182379
  — root cause: `parsePage` dôveruje voľnému textu/veľkostiam LEN na
  registrovaných doménach (issue 223/225 disciplína), cieľové domény tam
  jednoducho neboli. Zamietnutá alternatíva: slepo dôverovať JSON-LD/mikro-
  dátam na celej stránke bez obmedzenia na hlavný produkt (rovnaká chyba,
  akú issue 223/225 už raz opravili).
- Version bump `d44fb6e` (0.3.0-dev.142→.143), prvý commit.
- TDD (4 RED→GREEN páry): `94a2896`→`4c4d3f2` (5 domén v `parse.ts`:
  virginiashop.sk/tenolix.cz/luko.cz zdieľaná Shoptet šablóna
  `data-testid="labelAvailability"`, fomei.com mikrodata pred "Súvisiace",
  chiruca.sk zoznam veľkostí v `<select>`), `1698bcd`→`2b97513` (vylúčenie
  + čistenie forestshop.sk), `2f1bb0d`→`d2b455a` (GET vracia hostOverview/
  ownShopLinksCount), `d68f2a2`→`9b313f6` (obrazovka — nová karta + upozor-
  nenie). `pnpm test` (571+413), `pnpm test:integration` (476, novo
  pridaný `supplier-stock-http.integration.test.ts` — dovtedy pre túto
  trasu žiadny integračný test neexistoval), `pnpm --filter @forestshop/web
  e2e` (37, nový `supplier-stock.spec.ts` s izolovaným účtom
  `e2e-domeny@forestshop.sk`) — všetko zelené pred pushom.
- `luko.cz` má naživo overenú len zelenú vetvu (35 z 36 sledovaných odkazov
  sú viacveľkostné produkty bez `data-testid`, ostávajú `unknown`) —
  zdokumentované ako zámerný, čiastočný pokrok v `.claude/rules/
  supplier-stock.md`, nie tichá medzera.
- `superpowers:requesting-code-review` (base `46a87eb8` → head `b977e50`):
  0 Critical, 1 Important (chýbajúci tento log — doplnené týmto commitom),
  5 Minor (duplicitná scan logika `collectSupplierLinks`/`countOwnShopLinks`
  — ponechané, MVP filozofia, žiadny spoločný volajúci; redundantný
  `count(*)` v ORDER BY — SKÚSENÉ nahradiť aliasom `total`, Postgres to
  odmietol `column total does not exist` cez drizzle-ov `FILTER`-generovaný
  SQL, vrátené späť a zdokumentované; slabšia e2e asercia na celý riadok —
  spresnené na konkrétne `<td>` bunky). PR #249.

## 2026-08-05 — #245 (product.related_codes je po #238 mŕtvy kód)

- Solo ticket (Scope-gate: schema-migration, own PR, no bundling).
- Version bump `b27c047` (0.3.0-dev.145→.146), first commit.
- RED `1eb998c`: mapRow record must not have `relatedCodes` key
  (`map-row.test.ts`, "mapRow už nevracia relatedCodes") + DB-level
  regression (`catalog-schema.integration.test.ts`, "stĺpec
  product.related_codes už v schéme neexistuje").
- GREEN `7fffa72`: incremental migration `0033_breezy_manta.sql`
  (`ALTER TABLE product DROP COLUMN related_codes`), removed
  `extractRelatedCodes`/`RELATED_COLUMNS`/`MAX_ALTERNATIVES` +
  `VariantRecord.relatedCodes` from `map-row.ts`, removed population
  in `ingest.ts` (insert + onConflictDoUpdate), removed unused
  `relatedCodes` fixture option from `tests/helpers/orders.ts`.
- Code review (dispatched subagent) found `.claude/rules/nedostupne.md`
  had two stale notes from #238 describing the column as "still in
  code, follow-up: #245" — fixed in `8cbc129` (docs-only, `[no-design]`
  bypass since it's a review-feedback playbook fix, not a new design
  decision).
- PR #252, merge `eb580d97`. Live-verified on dev2: `related_codes`
  column gone from production `product` table (0 rows in
  information_schema), row counts intact (4542 products / 14139
  variants), manual "Stiahnuť teraz" catalog-import trigger completed
  with no error, console clean. Deployed version `0.3.0-dev.146`.

## Issue 255 — cross-row/unmount guard siblings (found during issue 254)

- Version bump `c7e5f13` (0.3.0-dev.148 → 0.3.0-dev.149).
- `[red]` test `dba794d`: `pairing.spec.ts` — bulk group-editor cross-row
  race ("uloženie bulk adresy skupiny A ... nesmie zavrieť bulk editor
  skupiny B otvorený medzitým"). Confirmed FAILS against unfixed code
  (`vstupB.isVisible()` → `false`).
- `[green]` fix `78a307b`: `PairingSection.tsx`'s `saveManualUrlForGroup`
  gets an `editingGroupKeyRef` "latest ref" guard (mirrors the existing
  `editingKeyRef` fix from issue 251/254, for the bulk/group path).
  `PairingSection.tsx` + `CatalogPage.tsx` both get the `mountedRef`
  unmount guard `SupplierLinksSection.tsx` got in issue 251 finding 3 —
  no dedicated regression test for this half (investigated: no
  React-18-observable difference exists — see design comment on the
  issue and the commit body).
- Both fixes reuse `FOREST_5003_PRODUCT_KEY`/`G7_LIGHT_PRODUCT_KEY`
  (already declared for issue 254's per-variant race tests), positioned
  BEFORE those tests in the file so both groups are still homogeneous —
  see `.claude/rules/pairing.md`'s new entry (only one fully-unused
  multi-variant group remains in the fixture after issue 47/254).
- Local gates all green: `pnpm typecheck`, `pnpm lint`, `pnpm --filter
  @forestshop/web test` (413 tests), `pnpm --filter @forestshop/web e2e`
  (42/42).

## Issues 260/259/258 — "Na objednanie": kusy, farby, kompaktné dlaždice (batch, one PR)

- **#260 (bug):** `summarizeOrderLines` (`ordersSummary.ts`) counted LINES
  (`lines.length`, `+= 1`), not summed `quantity` — two identical products
  merged into one `order_line` with `quantity: 2` (`ingest.ts`'s known
  same-product-same-order merge) showed as "1", not "2". RED
  (`ffc7604`→`3cbbae8`) proved the exact symptom against unfixed code
  (`{total:1,remaining:1}` vs expected `{total:2,remaining:2}`), GREEN
  (`4058d02`) fixed every field to sum `line.quantity`. `OrdersSection.tsx`'s
  nav badge (issue 147, its own documented "count of LINES" intent) was
  deliberately given its OWN direct `isLineResolved` filter instead of
  riding `summarizeOrderLines(...).remaining`, so it keeps its original
  meaning unchanged.
- **#259 (enhancement):** row coloring went from 3-state
  (`state-caka_sa`/`state-skladom`/`state-nedostupne`) to BINARY red/green
  keyed on the canonical `isLineResolved` predicate (`4c1ff17`) — owner's
  verbatim mapping: red = already done, green = still to order. The old
  3-state scheme left the DEFAULT/most-common "objednane" rows fully white,
  which is what the owner meant by "nothing is colored today".
- **#258 (enhancement):** overview tiles block compacted (`a656302`) —
  measured live via `page.addStyleTag` against production: 103px/79.5px
  tile → 58.5px, `.orders-overview` block 253.5px → 169px (−33%) at
  1366×768, all 7 numbers stay fully readable.
- Design/root-cause/rejected-alternative comments posted to all three
  issues BEFORE their first code commit; STILL-VALID evidence comments
  posted for each (live Playwright screenshots + measurements against
  `forestshop-novy.newlevel.media`).
- Local gates all green: `pnpm typecheck`, `pnpm lint`, `pnpm --filter
  @forestshop/web test` (421 tests, 52 files), `pnpm --filter @forestshop/api
  test` (571 tests), `pnpm --filter @forestshop/api test:integration` (477
  tests), `pnpm --filter @forestshop/web e2e` (42/42).

## Issue 257 — Zlúčenie objednávok (majiteľova korekcia: záložka, nie tlačidlo)

- Prevzaté od pozastaveného workera: verzia už bola bumpnutá (0.3.0-dev.151,
  4c3e582), salvage mail-log/mail-templates/env.ts infra + preview-token
  modul + migrácia `0034_melodic_wild_child` (zostali nezmenené — nezávislé
  od vstupného bodu).
- Commit `17de3be` — backend: `listMergeCandidateGroups` (merge-mail.ts) +
  HTTP trasy `GET/POST /api/order-merge/*` + wiring do app.ts/index.ts +
  mail-log-routes.ts enum + docker-compose.prod.yml BCC premenná. Unit test
  `formatOrderNumbers` (src), integration test `order-merge-http
  .integration.test.ts` (kandidáti/preview/send/role-gating).
- Commit `8cc6e9c` — frontend: `OrderMergeSection.tsx` + `orderMergeApi.ts`
  + nová záložka v `nav.ts`'s Eshop priečinku (12. záložka) + e2e fixtúra
  (dve objednávky bez `order_line`) + `order-merge.spec.ts`.
- Design comment na tickete (root cause, salvage vs. zmena, alternatívy)
  pred prvým kódovým commitom.
- Lokálne gates: `pnpm typecheck`, `pnpm lint` čisté; web unit 421/421 (52
  súborov), API unit 579/579 (36 súborov), API integration 484/484 (66
  súborov, po `db:migrate`), e2e 43/43.
- Playbook: `.claude/rules/database.md` (nová `pgEnum` hodnota potrebuje
  `db:migrate` PRED `test:integration`, inak `insertEntry`'s tiché
  prehltnutie zápisu vyzerá ako bug), `.claude/rules/orders.md`
  (`listMergeCandidateGroups` nepotrebuje `order_line` + testid podľa
  `externalOrderId`, nie UUID).

## Issue 263 — Na objednanie: farbiť riadok dodávateľa (nie produkty), výrazné farby (2026-08-05)

- Commit `c0d9677` — chore: version bump 0.3.0-dev.152.
- Commit `5c604af` — `[red]` failing unit tests (`OrdersToolbar.test.tsx`
  chip-all, nový `SupplierActionsPanel.groupColor.test.tsx`) + live e2e
  colour assertions in `orders-layout.spec.ts`.
- Commit `0080b24` — `[green]`: `--chip-done/todo/active-bg/text` root
  CSS vars; `.chip`/`.toorder-supplier` recoloured (green/red/orange);
  new `chip-all` modifier keeps "Všetci" neutral (no data state); removed
  issue 259's `tr.order-row.line-resolved`/`.line-unresolved` colouring
  entirely + its now-obsolete test file.
- Commit `d8a7b3a` — strengthened e2e proof that active (orange) really
  overrides done (red) via getComputedStyle, not just class presence.
- Commit `12b969b` — playbook entries (`.claude/rules/frontend-design.md`).
- Design comment + STEP 0 validation comment + review comment all posted
  to issue 263 before/after the respective steps.
- Lokálne gates: `pnpm typecheck`, `pnpm lint` čisté; web unit 425/425
  (53 súborov), API unit 579/579 (36 súborov), API integration 484/484
  (66 súborov, po `db:migrate`), e2e 44/44.
- No PR/merge/deploy in this dispatch — supervisor owns CI/PR/merge/deploy
  for this ticket per the dispatch's HARD CONSTRAINT.

## Issue 264 — Nastavenie farieb: koliesko vpravo hore, popup s paletou a živým náhľadom

- Commit `5c776bb` — chore: version bump 0.3.0-dev.153.
- Commit `38b20d8` — `[red]`: `theme-colors.integration.test.ts`,
  `applyThemeColors.test.ts`, `ThemeColorPicker.test.tsx`, `Topbar.test.tsx`
  (new `role`/`onSessionExpired` props), `theme-colors.spec.ts` (e2e).
- Commit `f36dbf1` — `[green]`: new `theme_color` table (key/value/
  updatedAt/updatedByUserId, same "row = customized, missing = code
  default" shape as `mail_template`/issue 192); `modules/theme-colors/
  {registry,store}.ts` + `http/theme-color-routes.ts` (GET any logged-in
  user, PUT/reset admin+manazer, all-or-nothing hex validation, 200
  {ok:false} never 4xx); `applyThemeColors.ts` shared CSS-var helper used
  by both `App.tsx` (apply-on-login, every role) and `ThemeColorPicker.tsx`
  (live preview on every keystroke/drag); circle button in `Topbar.tsx`
  (admin/manazer only); e2e-setup.ts isolated `e2e-farby@forestshop.sk`
  fixture + `theme_color` added to both TRUNCATE lists.
- Commit `a77472e` — code-review fixes (two independent passes): 🔴
  Cancel/Escape/backdrop-click during an in-flight Save/Reset reverted the
  live CSS preview to baseline while the server had already persisted the
  NEW colours — `close()` now no-ops while `busy` (+ `disabled={busy}` on
  Cancel), with a regression test proving it; 🟡 missing
  `ThemeColorsUnauthorizedError` handling on save/reset catches; 🟡 reopen
  without resetting stale `colors`/`draft`/`baseline`; 🟡 stale-fetch guard
  (`fetchSeqRef`) for rapid close+reopen; 🔵 strengthened a tautological
  empty-input test in `applyThemeColors.test.ts`.
- Design comment + STEP 0 validation comment + review comment all posted
  to issue 264 before/after the respective steps.
- Playbook entry added to `.claude/rules/frontend-design.md` — the
  "async popup: `close()` must no-op while `busy`" gotcha + the
  "reopen must reset stale state" gotcha, for any future editable-settings
  popup with Save+Cancel in this codebase.
- Lokálne gates (po review fixoch): `pnpm typecheck`, `pnpm lint` čisté;
  web unit 433/433 (54 súborov), API unit 579/579 (36 súborov), API
  integration 491/491 (67 súborov, po `db:migrate` — nová migrácia
  `0035_sturdy_darkstar.sql`), e2e 45/45 (nový `theme-colors.spec.ts`
  overený aj samostatne po fix commite).
- No PR/merge/deploy in this dispatch — supervisor owns CI/PR/merge/deploy
  for this ticket per the dispatch's HARD CONSTRAINT.

## Issue 264 follow-up — hláška pri neplatnom kóde farby

- `d006f47` chore: bump version to 0.3.0-dev.154 (issue 264 follow-up)
- `d30a942` [red] test: neplatný kód farby zobrazí hlášku + aria-invalid
  (`ThemeColorPicker.test.tsx`) — confirmed failing before the fix.
- `732f6f6` [green] fix: zrozumiteľná hláška + aria-invalid pri neplatnom
  kóde farby (`ThemeColorPicker.tsx`, `app.css`) — odvodená množina
  `invalidKeys` (rovnaký princíp ako existujúce `allValid`/`dirty`), nový
  `role="alert"` blok (`themecolor-hex-invalid`), `aria-invalid` na
  hex `<input>` + `[aria-invalid="true"]` CSS s `--fs-danger` tokenmi.
- Extended `theme-colors.spec.ts` (existing e2e) with the same proof:
  message text/visibility, `aria-invalid` set then cleared.
- Design comment posted to issue 264 before the first code commit.
- Playbook entry added to `.claude/rules/frontend-design.md` — "derive
  the invalid-field message/marker from existing validation state,
  don't add a new useState" gotcha.
- Local gates: `pnpm typecheck`, `pnpm lint` clean; web unit 433/433 (54
  files); API unit 579/579 (36 files); API integration 491/491 (67
  files, after `db:migrate` — no new migration this time); e2e 45/45
  (54.6s→55.7s, `theme-colors.spec.ts` now includes the invalid-hex
  check).
- No PR/merge/deploy in this dispatch — supervisor owns CI/PR/merge/deploy
  for this follow-up per the dispatch's HARD CONSTRAINT.

## issue 277 — Náhľad e-mailu: text sa dá upraviť priamo v okne pred odoslaním
- `5be33ca` chore: bump version to 0.3.0-dev.158.
- `2c38151`/`e7cc0ab` [red]/[green]: `renderEditedBody` (`mail-templates/
  render.ts`) — plain-text-edit → safe escaped HTML/text, exported
  `htmlEscape`. Pure unit tests (`render.test.ts`).
- `89febb3`/`0e297bb`: [red]/[green] `editedBody` flows through
  `sendNedostupneEmail`/`sendOrderMergeMail` (subject stays from the
  rendered template, only html/text get overridden) + new `mail_log.body`
  column (migration `0038_sad_kinsey_walden.sql`) — `sendLoggedMail` now
  persists `message.text` for every sender, not just the two editable
  ones. New integration file `mail-edited-body.integration.test.ts`
  proves: edited text is what's actually sent, the `mail_template` row
  the owner customized stays byte-identical after sending, and `mail_log`
  stores the edited text (HTTP round trip too — preview returns `text`,
  `/send` accepts `editedBody`, `GET /api/mail-log` shows it).
- `44ccc5f`: routes wiring (`nedostupne-routes.ts`/`order-merge-routes.ts`
  zod schemas + preview response `text` field), `mail-log/queries.ts`
  exposes `body`.
- `9d12ba5`: `MailPreviewDialog.tsx` — the read-only `dangerouslySetInnerHTML`
  div became a `<textarea>` bound to `bodyText`/`onBodyTextChange` (subject/
  recipient stay non-editable). Wired into `NedostupneSection.tsx`.
- `8b21cc0`: same wiring into `OrderMergeSection.tsx` + new unit test file
  (none existed before).
- `e559a8d`/`26b1c04`: [red]/[green] `MailLogSection.tsx` gets a per-row
  "👁 zobraziť text" toggle (only when `body !== null`) — the actually-sent
  text is now visible on the "Odoslané e-maily" screen, not just stored.
- `e61e6a4`: e2e specs (`nedostupne.spec.ts`/`order-merge.spec.ts`) updated
  to `toHaveValue()` on the textarea instead of `toContainText()` on the
  dialog (a `<textarea>`'s live value isn't part of DOM `textContent`) +
  added an actual edit-and-verify-value step in both.
- **Scope decision (documented on the ticket + in the PR):** only the TWO
  flows where Send is TODAY gated by Preview (server-enforced
  `previewToken`) got the editable dialog — Nedostupné tovary, Zlúčenie
  objednávok. "Pripomienky objednávok"/"Nevyzdvihnuté zásielky" show a
  preview that is informational only (Send doesn't require it, no
  previewToken) and "Objednávka dodávateľovi" is a HIDDEN feature
  (`SHOW_ORDER_MAIL_ACTIONS = false`, issue 118) — none of the three were
  converted; each documented with its reason rather than silently
  skipped.
- Design comment + STEP-0 validation comment posted to issue 277 before
  the first code commit.
- Local gates: `pnpm typecheck`, `pnpm lint` clean; web unit 459/459 (59
  files, incl. new `OrderMergeSection.test.tsx`); API unit 589/589 (37
  files); API integration 525/525 (70 files, after `db:migrate`); e2e
  46/46, zero console errors.
- No PR/merge/deploy in this dispatch — supervisor owns CI/PR/merge/deploy
  per the dispatch's HARD CONSTRAINT.

## Issue 276 — product code under order number, linked to our shop (2026-08-05)

- Version bumped to 0.3.0-dev.159 (dev==main after issue 277 merge) —
  own commit `d68908c` before the feature commit.
- Backend: `apps/api/src/modules/orders/queries.ts`'s
  `listOpenOrderLinesBySupplier` gained a LEFT JOIN on `shop_product_url`
  by variant code, new `OpenOrderLine.ourUrl: string | null` — same
  pattern as `nedostupne/queries.ts`'s `ourProductUrl` (issue 238), never
  `shopLinks.ts`'s search-fallback `ourProductLink` (used by `restock`
  only).
- Frontend: `ordersApi.ts`'s zod schema gained `ourUrl`
  (`.regex(/^https?:\/\//).nullable()`); `OrderLineRow.tsx` renders a new
  `.ord-code-cell` block under the order-number link — `<a>` when
  `ourUrl !== null`, plain `<span>` otherwise, never a dead/guessed link.
- Feature commit `272aee2` — new integration test
  (`orders-our-url.integration.test.ts`, 2 tests: known + unknown feed
  code), new unit test (`OrderLineRow.productCodeLink.test.tsx`, 2 tests),
  `orders.spec.ts` updated (stale issue-117 "code never shows" comment
  replaced + new link/plain-text e2e assertions on existing fixture rows
  "40287"/"4859/46" — no new e2e fixture data needed), ~19 existing
  `OrderLine`-shaped test fixtures given an explicit `ourUrl: null` field
  (this repo's "every field explicit" convention).
- Design comment + STEP-0 validation comment posted to issue 276 before
  the first code commit.
- Row-height ceiling (`orders-layout.spec.ts`, 105px) passed on the first
  local e2e run — but a dispatched code-review subagent correctly flagged
  that "ceiling passed" alone doesn't prove no systematic increase (the
  new `.ord-code-cell` line, unlike `.ord-remark-cell`, is ALWAYS
  rendered). Follow-up: temporary paired before/after instrumentation
  (`page.evaluate` measuring all `.order-row` heights, then toggling
  `.ord-code-cell{display:none}` and re-measuring) on both the isolated
  layout fixture and the global `E2E_FILTRE_EMAIL` 8-row fixture, across
  all 4 widths — every row's height was byte-identical before/after.
  Instrumentation reverted before commit; see `.claude/rules/orders.md`
  for the full finding + the "ceiling alone isn't proof" lesson.
- Review: dispatched `general-purpose` code-reviewer subagent
  (`superpowers:requesting-code-review`), diff `cb51a7a..272aee2`. Result:
  0 Critical, 1 Important (row-height proof, addressed above with the
  paired measurement), 2 Minor (unused `code-cell-` testid — now asserted
  in `OrderLineRow.productCodeLink.test.tsx`; playbook entry — added).
- Local gates (re-run after the review fixes): `pnpm typecheck`,
  `pnpm lint` clean; web unit 461/461 (60 files, incl. updated
  `OrderLineRow.productCodeLink.test.tsx`); API unit 589/589 (37 files);
  API integration 527/527 (71 files, after `db:migrate`); e2e 46/46 (full
  suite, before the review-triggered debug run), zero console errors.
- No PR/merge/deploy in this dispatch — supervisor owns CI/PR/merge/deploy
  per the dispatch's HARD CONSTRAINT.

## Issue 292 — DPD: objednať prepravu jedným tlačidlom (2026-08-08)

- Commits: `463279e` (version bump 0.3.0-dev.183) → `1d6a627` (backend:
  schema/ingest/preview/routes) → `6761e8a` (frontend: "Eshop → Preprava
  DPD") → `c9985b0` (e2e coverage + fixtures, nav tab-count updates) →
  `b205a90` (playbook `.claude/rules/dpd.md`) → `dc3a66d` (review fixes).
- Design: `gh issue comment` on #292 BEFORE first commit — root cause
  (appka never stored delivery address/weight/payment method, though the
  Shoptet export already carries them), chosen approach (per-shipment
  Playwright robot, since Importné profily bulk-import was empty on the
  account and mapping its format requires a WRITE the ticket's safety
  rule forbids), rejected alternatives (official DPD Shipper API — owner
  explicitly reversed that decision on the ticket; deriving
  "ready to ship" from Shoptet `status_name` — no reliable vocabulary for
  it, own `dpd_shipment` record used instead).
- No RED/GREEN pair — new feature, not a bug fix. Tests: unit
  (`parser-order-extra.test.ts`, `preview.test.ts`, `DpdSection.test.tsx`),
  integration (`dpd-http.integration.test.ts`, injected fake Playwright
  runners — never spawns real Chromium/touches the real account),
  e2e (`dpd.spec.ts` — proves the deployed shape is fail-closed without
  DPD credentials; the actual send-flow interaction is covered only by
  the mocked-API component test, e2e correctly has NO real DPD
  credentials by design).
- Review: dispatched `general-purpose` code-reviewer subagent, diff
  `d15c58d..b205a90`. Result: 0 Critical, 2 Important (weight-override
  map sent unfiltered to the server — could 400 a valid selection because
  of a stale draft on an unrelated row; `addressComplete` missed house
  number), 1 Minor (`POST /api/dpd/preview` missing `requireSameOrigin()`
  for consistency) — all three fixed in `dc3a66d`.
- Local gates: `pnpm typecheck`/`pnpm lint` clean; API unit 652/652 (46
  files); API integration 608/608 (81 files); web unit 522/522 (71
  files); e2e 51/51 (52 spec files incl. new `dpd.spec.ts`), zero console
  errors.
- PR #320 merged (`59d6623`) to `main`; main CI + Deploy both green.
  Post-deploy Playwright verification on
  `https://forestshop-novy.newlevel.media/?tab=dpd`: version `v0.3.0-dev.183`
  read from DOM, "Preprava DPD" tab renders, 258 real orders listed (all
  showing "Chýba adresa" — expected, delivery-address columns are `null`
  until the next nightly Shoptet re-import backfills them via COALESCE),
  default weight `1.00` applied correctly, both send/pickup buttons
  correctly `disabled` (DPD not configured on prod — credentials never
  arrived this session), 0 console errors.
- **Issue 292 LEFT OPEN** (never `Closes` in PR/commits) — the actual
  `/shipments/0` form-fill and pickup-form-fill are intentionally
  unmapped (fail loudly with a clear message instead of guessing
  selectors) pending `DPD_PORTAL_USER`/`DPD_PORTAL_PASSWORD` (requested
  via `secret request` repeatedly overnight, 600s URL TTL expired
  unused each time — owner was asleep). First real shipment must be
  clicked by the owner himself once the form is live-mapped.

## Issue 319 — Vypredané → Skladom: 'Spustiť teraz' restock deps wiring (2026-08-08)

- Commits: `742af17` (version bump 0.3.0-dev.184) → `6571eda` [red]
  static-source regression test → `ec4eb5d` [green] fix → `c53b937`
  (playbook `.claude/rules/supplier-stock.md`).
- Validated FIRST: another worker's own prior live observation
  (2026-08-07, click returned `nothing_to_do`) looked like it contradicted
  the ticket. Traced `runRestockLocked` — it returns `nothing_to_do`
  BEFORE ever touching Shoptet login when there are 0 candidates, so the
  observation didn't rule anything out. Cross-referenced production
  `job_run`/`audit_events`: a `failure` row at 2026-08-06 12:37:16 carried
  the exact predicted "prihlasovací formulár stále viditeľný" error, right
  after a manual `restock.enabled.set` toggle, with no matching
  `restock.run_now` audit row (the HTTP handler's `record()` is skipped on
  the exception path) — confirmed the ticket was genuinely valid, posted
  as its own `gh issue comment`.
- Design: root cause traced to `index.ts`'s `createApp(db, {...})` never
  passing a `restock` key (only gap of its shape — checked all `options.*`
  in `http/app.ts` against the call site). Chose the ticket's own
  one-line fix over making `restock` a required `AppOptions` field
  (rejected — would force editing ~35 existing test files calling
  `createApp` without `restock`, for no behavioral gain since `http/
  app.ts`'s fail-closed fallback is itself the documented intended
  design).
- RED/GREEN: `index.ts` can't be safely imported in a test (module-top-level
  DB migration + `serve()`), so the regression test statically reads the
  source and regex-checks the `createApp(...)` call block references the
  real `shoptetAdminUser ?? ""`/`shoptetAdminPassword ?? ""` variables —
  independently re-verified by the deep-review subagent, which re-ran the
  test against the pre-fix source and confirmed RED.
- Review: `/review` inline (0/0/0) + dispatched `general-purpose` deep
  reviewer with precisely-crafted context (BASE `1067197`/HEAD `ec4eb5d`,
  no session history) — 0 Critical/Important/Minor, confirmed `restock`
  was the only wiring gap and the fix preserves the fail-closed default
  when env vars are absent.
- Local gates: `pnpm typecheck`/`pnpm lint` clean; API unit 653/653 (46
  files); API integration 608/608 (81 files); web unit 522/522 (71
  files); e2e 51/51 (52 spec files), zero console errors.
- PR #321 merged (`f336e38`) to `main`; main CI + Deploy both green.
  Post-deploy verification: DOM version `v0.3.0-dev.184`; directly
  `docker exec`'d into the running container and confirmed
  `dist/index.js` carries the fix verbatim (not just that CI passed);
  clicked "⚡ Spustiť teraz" live — succeeded, 0 console errors,
  `job_run` `success {"status":"nothing_to_do"}` (0 candidates waiting at
  the time, so this specific click never reached the Shoptet-login step).
  Closed the ticket on the strength of: the deployed code now calls the
  IDENTICAL `shoptetImportConfigFromBaseUrl(...)` with the IDENTICAL
  credentials that the scheduled `restockJob` (2026-08-07 18:10, "ok,
  switched 1") and the hourly `shoptet-writeback` job repeatedly prove
  valid — documented explicitly on the closing comment, with an
  invitation to reopen if a real candidate somehow still fails.

## Issue 309 — Upozornenia: najbližšia udalosť z Google kalendára (2026-08-08)

- Commits: `84876f8` (version bump 0.3.0-dev.185) → `f12b7cc` (backend:
  `modules/calendar/` + `GOOGLE_CALENDAR_ICS_URL` wiring) → `49bde35`
  (frontend: `NextCalendarEventCard`) → `9a41fc0` (e2e race fix from
  deep-review finding) → PR #322 merge `398f52c`.
- Design (posted BEFORE first code commit, `gh issue comment 309`):
  ticket's own recorded owner-Discord comment already settled the access
  method (secret iCal URL, option 1) — treated as a technical decision,
  never re-asked. Architectural choice: independent `modules/calendar/`
  module, NOT the DB-backed `upozornenie` dedupKey/resolve pattern (no
  "vybaviť" semantics apply to a live read-through calendar view) —
  short-lived in-memory cache (15 min ok / 2 min error) instead of a new
  scheduler job + DB table, since nothing needs to persist or survive a
  restart meaningfully. `node-ical` chosen over hand-rolled RRULE parsing
  (`investigate-existing-first`) — RFC 5545 recurrence is a known minefield
  (DST, EXDATE, RECURRENCE-ID overrides).
- Real correctness pitfall found + fixed BEFORE any test was written:
  `node-ical` interprets floating `VALUE=DATE` (all-day) values using the
  RUNNING PROCESS's timezone — verified empirically (`TZ=UTC` vs
  `TZ=Europe/Prague` give different absolute instants for the identical
  ICS text). Since CI runs UTC and production runs `TZ=Europe/Bratislava`
  (issue 293), a naive instant comparison would silently disagree between
  environments. Fix: reuse the project's own `timezone.ts`'s
  `zonedDateKey` to compare CALENDAR DAYS in Europe/Bratislava for all-day
  events (proven safe regardless of which offset node-ical used
  internally, since Bratislava is always 0–2h ahead of UTC) — documented
  in the new `.claude/rules/calendar.md`.
- Security: the Google secret ICS URL carries its token in the PATH, not
  a query parameter (unlike every existing Shoptet integration in this
  repo) — the existing `redactUrl` helper (query-param-only) would leak
  it. `calendar/fetcher.ts` never interpolates the URL into any thrown
  error/log line at all; `fetcher.test.ts` asserts this directly.
- Tests: unit (`next-event.test.ts` 13 cases against the REAL `node-ical`
  library — all-day, timed, ongoing, RRULE, EXDATE, CANCELLED;
  `fetcher.test.ts` 3 cases — timeout/size-cap/no-URL-in-error;
  `service.test.ts` 6 cases — TTL cache, error TTL, concurrent dedup),
  integration (`calendar-http.integration.test.ts` 4 cases — not
  configured/success/fetch-failure/401), web unit (`calendarApi.test.ts`
  5, `NextCalendarEventCard.test.tsx` 5 incl. StrictMode unmount-race
  guard), e2e (extended `upozornenia.spec.ts` — card absent when
  unconfigured, real `waitForResponse` proof, not a timing coincidence).
  No test ever contacts the real Google.
- Review: manual `/review` on the PR diff (0/0/0) + dispatched
  `general-purpose` deep reviewer with precisely-crafted context (BASE
  `f336e38`/HEAD `5a4a3e5`, no session history) — verdict "ready to
  merge", one legitimate Important finding (E2E `waitForResponse` race —
  fixed in `9a41fc0`) and one Important finding correctly identified as
  out-of-scope (the "owner hasn't confirmed the access method" concern —
  already explicitly settled per the dispatch's own instruction, not a
  code issue).
- Local gates: `pnpm typecheck`/`pnpm lint` clean; API unit 675/675 (49
  files, incl. new calendar tests); API integration 612+/612+ (82+
  files); web unit 532/532 (73 files); e2e 51/51 (52 spec files), zero
  console errors, one unrelated known-flaky test (`.claude/rules/
  testing.md`'s documented shared-box load pattern) reproduced green on
  isolated re-run.
- PR #322 merged (`398f52c`) to `main`; main CI + Deploy both green.
  Post-deploy verification (Playwright, logged-in as the real owner
  `vychod@varos.sk`): DOM version `v0.3.0-dev.185`, "Upozornenia" tab
  loads with ZERO console errors, no calendar card renders (matches
  `configured:false` — production has no `GOOGLE_CALENDAR_ICS_URL` set
  yet), direct `fetch("/api/upozornenia/next-event")` from the live page
  confirmed `{"configured":false,"event":null,"error":false}`.
  **UNVERIFIED: the real-event rendering path** (a genuine calendar
  event's date/title actually appearing) — the owner has not yet pasted
  his calendar's secret iCal URL into `/srv/forestshop/.env` on dev2.
  Issue 309 deliberately left OPEN (`needs-answer` label kept) with a
  comment explaining the only remaining step is that one paste — no
  `Closes #309` anywhere in the PR body or any commit message (this repo
  merges via merge commits, so commit messages reach `main` intact and
  would auto-close too).

## Issue 327 (10. 8. 2026) — Upozornenia: kompaktné karty, bez stavu Nevybavená, s mazaním

- Verzia 0.3.0-dev.189 → 0.3.0-dev.190 (`c59f8c7`).
- Commity: `0bbbeec` [red] test na `isUnfinishedOrderStatus("Nevybavená")
  === false`, `b6c7861` [green] `UNFINISHED_ORDER_STATUS_NAMES` → len
  "Vybavuje sa" (existujúce otvorené karty sa AUTOMATICKY zatvoria
  ďalším `ordersImportJob` behom, žiadna migrácia), `dacff9f`
  `deleteOwnNote` → generická `deleteUpozornenie` (VŠETKY zdroje),
  `d359fdb` kompaktné karty (nadpis+meta na jednom riadku, nadpis =
  odkaz, akčný riadok ≥25 % nižší — živo zmerané 35.59px→25.59px),
  `3378a1d` code-review fixy (`deleteUpozornenie` teraz odmieta
  vyriešené karty — chráni `vratenie`'s KONEČNOSŤ; playbook update;
  e2e strop sprísnený na 26.69px; `splitDetailLines` exportovaná +
  vlastný test).
- Dispatchovaný Senior Code Reviewer subagent (rozsah `c59f8c7..d359fdb`):
  0 🔴, 2 Important + 3 Minor, všetky opravené pred pushom.
- Testy: web unit 74/74 súborov (539 testov), api unit 51/51 (690
  testov), api integration 84/84 (629 testov), e2e 51/51 (52 spec
  súborov) — zero console errors.
- PR #328 merged (`123b769`) do `main`; main CI + Deploy oba zelené.
  Deployed image `ghcr.io/zbynekdrlik/forestshop-app:0.3.0-dev.190`
  potvrdený na dev2.
- Post-deploy naživo overené (Playwright, prihlásený ako majiteľ
  Zbyněk/admin): karta 115.58px (predtým 149.58–175.17px podľa
  obsahu), akčný riadok 25.59px; nadpis je funkčný odkaz s
  aria-label; ručne spustené "Stiahnuť teraz" (Objednávky) na
  produkcii AUTOMATICKY zatvorilo obe existujúce otvorené "Nevybavená"
  karty (žiadny manuálny DB zásah); tlačidlo "Odstrániť" funkčne
  overené vytvorením + zmazaním testovacej vlastnej poznámky; 0 chýb v
  konzole počas celého overenia.
- Issue 327 zavretý s dôkazovým komentárom po živom overení.

## Issue 329 — Vypredané → Skladom: odkaz na náš produkt v Prepnutých produktoch (2026-08-10)

- Verzia zdvihnutá 0.3.0-dev.191 → 0.3.0-dev.192 (feature) → 0.3.0-dev.193
  (playbook-only follow-up po merge, mandatory bump).
- Design: e1436b8-predchádzajúci komentár na tickete PRED prvým commitom —
  z troch tabuliek na obrazovke "Vypredané → Skladom" mala odkaz na náš
  produkt DVE (Rozpory, Pripravené na prepnutie); tretia ("Prepnuté
  produkty" — história) NEmala žiadny. Zámerne bez fallbacku na
  vyhľadávanie (na rozdiel od `ourProductLink`), presne podľa zadania
  ("odkaz sa proste nezobrazí" pri chýbajúcej feed adrese).
- Backend: `listRestockEvents()` (`restock/queries.ts`) — LEFT JOIN
  `restock_event` → `shop_product_url`, rovnaký vzor ako existujúci
  `allRestockCandidates`'s `ourUrl`.
- Frontend: nový `feedOnlyProductLink()` helper (`shopLinks.ts`), nový
  stĺpec "Náš produkt" v tabuľke "Prepnuté produkty" (`RestockSection.tsx`).
- Testy: unit (`shopLinks.test.ts`, `RestockSection.test.tsx`), integračný
  (`restock-run.integration.test.ts`), nový Playwright e2e
  (`restock-events.spec.ts` + vlastná fixtúra `e2e-fixtures-restock-events.ts`).
  Web unit 74/74, api unit 51/51, api integration 84/84, e2e 52/52 spec
  súborov — zero console errors.
- Nezávislý code review (subagent, `superpowers:requesting-code-review`):
  0 🔴 0 🟡, 1 🔵 (informačná, pre-existujúci vzor, bez akcie).
- PR #333 (feature, `c2660b7`) + PR #334 (playbook + povinný version bump,
  `804806f`) — oba zlúčené do `main`, CI aj Deploy zelené na oboch.
- Post-deploy naživo overené (v0.3.0-dev.193): 3 reálne riadky "Prepnuté
  produkty" viedli na SPRÁVNY produkt (title stránky sedel s názvom),
  `target="_blank"` + `rel="noreferrer noopener"` na všetkých, výška
  riadku nezmenená (67.5625px na všetkých 6), 0 chýb v konzole appky.
- Playbook: `.claude/rules/supplier-stock.md` — ktorá z troch tabuliek
  odkaz mala/nemala + vitest `getByRole` kolízia pri druhom riadku so
  zhodným prístupným menom (`within(riadok)` fix).
- Issue 329 zavretý s dôkazovým komentárom po živom overení.

## 2026-08-11 — #331 (Vypredané → Skladom: chýbajúce odkazy — hlavná príčina malého počtu prepnutí)

- Solo ticket. Version bump `d714fd8` (0.3.0-dev.195→.196), first commit.
- STEP 0 (validácia) + design komentár PRED prvým kódovým commitom:
  https://github.com/zbynekdrlik/forestshop-app/issues/331#issuecomment-5246739482
  (živé overenie: 34 dnes chýbajúcich, VŠETKY majú kandidáta — #311's
  mechanizmus je v poriadku) a
  https://github.com/zbynekdrlik/forestshop-app/issues/331#issuecomment-5246745247
  (príčina: (b) číslo nikde inde vidno + (c) 0 potvrdení od nasadenia #311;
  zamietnutá alternatíva: karta na nástenke Upozornenia).
- Fix: odznak v ľavom menu (`App.tsx`'s `restockLinksMissingCount`, rovnaký
  vzor ako `upozorneniaCount`/#267 — nová `restockLinksBadgeContext.ts`,
  `fetchRestockLinksMissingCount` v `restockLinksApi.ts`, reuse
  `GET /api/restock-links?pageSize=1`) + jednoklikové "✅ Potvrdiť" kandidáta
  (`RestockLinkSuggestionsSection.tsx`'s `confirmCandidate`, náhrada za
  dvojklikový "💡 Použiť → 💾 Uložiť"), "✏️ Doplniť" bezo zmeny.
- Testy: unit (`RestockLinkSuggestionsSection.test.tsx` — nový
  jednoklikový test + "nič sa neuloží len z načítania" test), integračný
  (`restock-links-http.integration.test.ts` — `total` nezávislé od
  `pageSize`), e2e (`restock-links.spec.ts` — odznak hneď po prihlásení +
  prepísaný jednoklikový flow). Web unit 544/544, api unit 699/699, api
  integration 631/631, e2e 53/53 (jeden `pairing.spec.ts` flake na
  preťaženom boxe, izolovaný re-beh aj plný balík znova čisté).
- Nezávislý code review (subagent): 0 🔴 0 🟡, 2 🔵 informačné, Ready to
  merge — Yes.
- PR #338 (`bb7f789`), CI aj Deploy zelené. Systémový nález (page=1/
  pageSize=50 bez ďalšej strany naprieč viacerými obrazovkami) zapísaný
  samostatne ako #337, nedotýkané v tomto PR.
- Post-deploy naživo overené (v0.3.0-dev.196): odznak "34" vidno HNEĎ po
  prihlásení bez otvorenia záložky, jeden reálny klik na "✅ Potvrdiť"
  (Fotopasca Wachman King II. gen) uložil odkaz, odznak aj "Nájdených"
  klesli na 33, hodnota sa objavila aj na "Párovanie produktov" (zdieľaná
  zápisová cesta), 0 chýb v konzole. Testovací zápis zmazaný
  (`synced_at IS NULL` overené pred zmazaním), odznak sa vrátil na 34.
- Playbook: `.claude/rules/restock-links.md` — prečo #311 nezdvihlo
  pokrytie (chýbala viditeľnosť/rýchlosť, nie logika) + reusable technika
  overenia produkčnej logiky priamo cez appkin skompilovaný `dist/`
  (`docker exec ... node -e 'require("./dist/...")'`, `createDb()` vracia
  `{ pool, db }`, nie `db` priamo).

## Issue 337 (page=1/pageSize=50 na 4 obrazovkách, žiadna ďalšia strana)

- Commits: `c562da1` (shared `useLoadMore.ts` hook), `b2d910b`/`c8013d6`/
  `0222ac0`/`48abcd3` (zapojenie na CatalogPage/PairingSection/
  SupplierLinksSection/RestockLinkSuggestionsSection), `9d00b2f` (e2e
  fixtúra + Playwright dôkaz), `0185840` (catalog.spec.ts count bump),
  `f8b3d8e`/`2ae1a62`/`5985142`/`55de8a1`/`5a5b4ae` (2 review nálezy:
  🔴 `reset()` nikdy nevyčistilo `loadingMore`, 🟡 tlačidlo čítalo LIVE
  `query`/`state` namiesto naposledy odoslaného dopytu — oba RED-verified
  a opravené vo všetkých 4 obrazovkách).
- PR #341 (`352045e`), CI aj Deploy zelené (deploy raz zlyhal na známej
  containerd `failed to Lchown` chybe, vyriešené `docker pull` na dev2 +
  `gh run rerun --failed`, žiadna zmena kódu).
- Post-deploy naživo overené (v0.3.0-dev.200): "Eshop → Párovanie
  produktov" `Nájdených: 2302 (zobrazených prvých 50)` → klik "Načítať
  ďalšie" → 100 riadkov, "(zobrazených prvých 100)"; "Vypredané → Skladom:
  návrhy odkazov" (total 34, pod 50) tlačidlo správne chýba. 0 chýb v
  konzole na oboch.
- Playbook: `.claude/rules/frontend-design.md` — nový zdieľaný
  `useLoadMore.ts` hook (budúce obrazovky ho majú znovupoužiť) + 2 nové
  bullet-y generalizujúce review nálezy (generation-guard musí vyčistiť
  KAŽDÝ derivovaný stav, "latest ref" trieda platí aj pre onClick
  handlery, nielen `.then()` mikrotasky).

## Issue 343 (ľavé menu: Systém a Automatizácie zbalené predvolene)

- Commits: `af06d5a` [red] test (Sidebar defaultCollapsed), `14ea1e7`
  [green] `NavFolder.defaultCollapsed` + lazy `useState` initializer v
  `Sidebar.tsx`, `74428ff` súhrnný odznak/bodka na hlavičke zbaleného
  priečinka (code review nález na PR 348 — issue 331/267's odznaky boli
  predtým vidno hneď po prihlásení, zbalenie priečinka ich skrylo; fix
  pridáva agregát z tých istých `badgeCounts`/`badgeStatus` props,
  `aria-hidden` aby nezmenil accessible name tlačidla — RED-verified cez
  `git stash push --keep-index` na implementáciu).
- PR #348 (`f995d85d`), CI aj Deploy na main zelené na PRVÝ pokus (žiadna
  containerd flaka tentoraz). 8 e2e spec súborov aktualizovaných (klikajú
  priamo na záložku v Systéme/Automatizáciách, treba najprv rozbaliť
  priečinok) — grep celého `tests/e2e/` adresára potvrdil úplnosť.
- Rozhodnutie na tickete: stav zbalenia sa NEPAMÄTÁ medzi návštevami
  (šéf žiadal len predvolený stav).
- Post-deploy naživo overené (v0.3.0-dev.202): Eshop rozbalený, Systém aj
  Automatizácie zbalené, Automatizácie ukazuje "34" na hlavičke (súčet
  `restock-links` odznaku), po rozbalení zmizne a originály vnútri sú
  nezmenené. 0 chýb/varovaní v konzole.
- Playbook: `.claude/rules/frontend-design.md` — 3 nové bullety: per-
  priečinok `defaultCollapsed` v registri (nie hardcoded v Sidebar.tsx),
  `aria-hidden` gotcha pri pridávaní vizuálneho doplnku do pomenovaného
  tlačidla (inak sa zmení accessible name a rozbijú sa `getByRole`
  dotazy), a súhrnný ukazovateľ na zbalenom kontajneri sa počíta z
  existujúcich props bez nového fetchu.

## Issue 347 (e-maily zákazníkom: hlavička/pätička, produktová karta s obrázkom namiesto holej adresy)

- Commits: `cb51182` [red] test (skeleton + card rendering), `7c52e1c`
  [green] `mail-templates/layout.ts`'s `wrapEmailHtml` + `render.ts`'s
  `productCardHtml`/`textListItemLine`, `19dae96` shop-feed `image_url`
  stĺpec (additive migrácia `0045_narrow_leper_queen.sql`) + `<g:image_link>`
  parsing, `69ee99e` `nedostupne/resolve-products.ts` (URL → názov/obrázok/
  cena, presná zhoda potom zhoda podľa cesty), `40cdf1e` zapojenie do
  `logic.ts`/`send.ts`/`samples.ts`.
- PR #349 (`ff65a9dd`), CI na dev aj main zelené; Deploy raz zlyhal na
  známej containerd `commit failed: rename ... ingest` chybe, vyriešené
  `docker pull` na dev2 + `gh run rerun --failed`, žiadna zmena kódu.
  Review pass (fresh-context subagent nad celým diffom): 0 🔴 0 🟡 3 🔵,
  všetky len informačné.
- Post-deploy naživo overené (v0.3.0-dev.204): manuálne spustený
  `shop-feed` job v kontajneri (`.claude/rules/shop-feed.md`'s nový
  postup) na zaplnenie `image_url`, potom `/api/nedostupne/preview` pre
  PRESNE ten prípad z pôvodného nahláseného e-mailu (objednávka 20261306,
  variant 61729/M, Pavol Bajčičák) — text-verzia dáva názov produktu a
  adresu na samostatné riadky (žiadne "URL (URL)"), HTML ukazuje dve
  reálne produktové karty so skutočnými obrázkami z CDN, cenou aj
  tlačidlom "Zobraziť produkt", a oddelenú pätičku s klikacím telefónom/
  e-mailom/webom. 0 chýb v konzole. Screenshot vyrenderovaného e-mailu v
  hlásení.
- Playbook: `.claude/rules/mail-templates.md` (4 nové bullety: kostra sa
  volá z dvoch miest a supplier_order ju nikdy nepoužije, opt-in card-list
  rozšírenie, `dangerouslySetInnerHTML` div zahadzuje `<body>` štýl —
  predošlý limit nie regresia, manuálne spustenie shop-feed jobu pre
  naživo overenie), `.claude/rules/shop-feed.md` (`image_url` stĺpec +
  presný `docker exec` postup na ručné spustenie jobu), `.claude/rules/
  nedostupne.md` (dizajnové rozhodnutie: spätné dohľadanie namiesto
  duplikovania dát na `nedostupne_replacement_link`).

## 2026-08-11 — #344 (Nedostupné tovary — vybavené riadky odlíšené farbou)

- Solo ticket, owner-requested via Discord (boss, 11.8.2026 — "žiaden
  autopilot-skip", scope-gate `user-request`).
- Version already strictly above main (0.3.0-dev.205 > main's .204) —
  no bump commit needed.
- Design comment BEFORE first code commit:
  https://github.com/zbynekdrlik/forestshop-app/issues/344#issuecomment-5254401764
  — signal: `order.nedostupneSent || order.alternativaSent`; colour:
  `--fs-success`/`--fs-success-bg` (NOT the boss's literal "červené" —
  red already means error on this same screen, explained on the ticket);
  whole row (background + accent), not just the button; accessibility
  floor satisfied by the EXISTING unchanged "✓ Odoslané" button text.
  Rejected alternative: copying issue 259→263's row-coloring rejection
  from the Orders screen — different screen, this ticket explicitly asks
  for row-level distinction here.
- RED `d4066df` (unit test: data-handled attribute + modifier class,
  fails against unmodified component) → GREEN `5219f6c` (feat: border-left
  reservation + CSS).
- Review pass (fresh-context general-purpose subagent, PR #350, commit
  range `d4066df^..5219f6c`): 1 🟡 0 🔴 2 🔵 — 🟡 the transparent
  border-left reservation on every row shifted content ~11px right of
  the group header/replacement-links above it (no matching inset there);
  🔵 test coverage only 2/4 boolean combinations; 🔵 comment overclaimed
  "no layout change" (only height was proven). Fixed same branch, commit
  `3e9afef`: switched to `box-shadow: inset 3px 0 0 var(--fs-success)`
  (zero box-model impact, no reservation needed anywhere), `it.each`
  covering all 4 combinations, comment tightened.
- Main CI's `integration` job failed once on a single unrelated test
  (`order-note-playwright.integration.test.ts`, 60s timeout — shoptet
  writeback/Chromium, nothing this PR touches; same suite had already
  passed twice on dev's own CI). One `gh run rerun --failed` on run
  31507330187 came back green — treated as a transient CI-runner flake,
  not a regression (per `ci-monitoring.md`: one rerun to rule out a
  transient is acceptable).
- Merged `fb80ed3`, deployed + verified v0.3.0-dev.205 live on
  https://forestshop-novy.newlevel.media/?tab=nedostupne: two REAL
  already-sent orders (20261338/61634, 20261306/61729-M) render
  `data-handled="true"` with the green tint + accent, `getBoundingClientRect()`
  identical height/left vs. a pending row (no jog), 0 console
  errors/warnings, screenshot in the run.
- Playbook: `.claude/rules/frontend-design.md` (new bullet — per-row
  state accents must use inset `box-shadow`, never a reserved
  `border-left`, to avoid the alignment-jog class of bug this ticket's
  own review caught), `.claude/rules/nedostupne.md` (handled predicate +
  the "boss says a colour, check it doesn't already mean something else
  in this app" precedent).

## Issue 351 — tazke brany presunut z dev1 do CI

- Root cause: lokalny predpush zvyk spustal CELU sadu bran (typecheck,
  lint, unit, integration proti lokalnemu Postgresu, e2e so skutocnym
  Chromiom) — duplicitu toho, co ci.yml aj tak zadarmo znova bezi na
  ubuntu-latest. Namerane: zataz 15,6, 4,2 GB swap, eslint sam 1,5 GB.
  Design comment: issuecomment-5256903352.
- Commits: 50ea1f1 (version bump 0.3.0-dev.208), 080449f (gates:local +
  --concurrency=off + playwright workers:1 + playbook), 632cad8 (review
  fix — stale local-dev.md cyklus + eslint concurrency caveat).
- PR opened from dev to main, merged 79325b4, main CI + Deploy oboje
  zelene (vsetkych 5 jobov v CI vratane integration/e2e).
- Namerane pred/po (jeden reprezentativny beh): stara plna sada 539 s pod
  zatazou, peak load 4,60; nova gates:local 114 s, peak load 3,91 — 4,7x
  kratsi cas pod zatazou (integration 655 testov/336 s + e2e 55 testov uz
  lokalne default nebezia, len v CI).
- Post-deploy: /api/version + Playwright DOM zhodne s 0.3.0-dev.208 a
  merge SHA 79325b40, 0 console error/warning.
- Playbook: .claude/rules/local-dev.md (nova predvolena lokalna sada +
  namerane cisla), .claude/rules/testing.md (pointer na heavy-gates-CI-
  only), .claude/rules/ci.md (integration/e2e/docker-build musia ostat
  bezpodmienecne — plan na tom stoji).

## Issue 345 — Eshop: nová obrazovka Objednávky predajňa (2026-08-11)

- Šéfovo zadanie (Discord): nová záložka pre objednávky vzniknuté priamo
  na predajni, nie v e-shope. Predošlý komentár na tickete už zistil
  naživo znak: `order.shipping_carrier_name ILIKE '%Osobný odber%'`
  (podreťazec, nikdy presná veta) — 30→32 objednávok medzi 11.8. a
  overením pred implementáciou.
- Design comment: issuecomment-5257678317 (root cause + SQL-stránkovaný
  prístup vs. order-flags's load-everything-JS vzor + PAGE_SIZE=10
  rozhodnutie).
- Commits: 8d72d9d (version bump .210), d0c6d28 (nová GET
  /api/floor-orders + FloorOrdersSection.tsx + nav.ts + integration/e2e
  testy), 6b290ad (review opravy — tie-breaker `desc(orders.id)`,
  "latest generation" strážca v load(), empty-string pageSize preprocess,
  empty-state gate, nový FloorOrdersSection.test.tsx), 2ad541c (playbook —
  jest-dom matcher gotcha), 95837c1 (version bump .211).
- Review: issuecomment-5258302837 (0 🔴, 3 🟡, 4 🔵, všetko opravené v tej
  istej vetve).
- PR #354 (dev→main), merge 4e6f4b0. Deploy padol na známu containerd
  ingest chybu (`.claude/rules` known issue) — `docker pull` na dev2 +
  `gh run rerun --failed`, druhý pokus zelený.
- Post-deploy Playwright: v0.3.0-dev.210 v DOM, "Objednávky predajňa"
  otvorená z menu, 32 objednávok (sedí s naživo psql dopytom), najnovšie
  hore, Shoptet odkaz vedie na www.forestshop.sk/admin/, "Načítať ďalšie"
  pripojilo druhú stranu (10→20/32), konzola 0 chýb/varovaní.
- Druhé PR #355 (docs-only playbook zápis + version bump .211, keďže
  playbook-review beží AŽ po merge/deploy), merge 1dfe79c, main CI+Deploy
  oboje zelené, DOM potvrdzuje v0.3.0-dev.211.
- Playbook: `.claude/rules/orders.md` (predajňový filter + PAGE_SIZE
  rozhodnutie + ORDER BY tie-breaker gotcha), `.claude/rules/testing.md`
  (žiadny jest-dom v komponentových testoch — `getAttribute` namiesto
  `toHaveAttribute`, + rozšírené `paths:` na `apps/web/src/**/*.test.tsx`).
- Issue 345 zavretý s dôkazom (issuecomment-5258524496).

## Issue 357 — Výpadok: Cloudflare tunel QUIC handshake timeout (Error 1033)

- Commits: `c91b2aa` (version bump 0.3.0-dev.213), `6074931` (fix + monitor).
- Root cause: `cloudflared` predvolene ide QUIC (UDP 7844); handshake na sieti
  dev2 prestal prechádzať na všetkých 4 spojeniach naraz -> tunel bez živého
  spojenia -> Cloudflare 1033. Appka aj DB boli celý čas OK.
- Ranná ručná oprava (`--protocol http2` priamo na dev2) teraz aj v repe
  (`docker-compose.prod.yml`) — `deploy.yml` inak prepíše server súbor pri
  ďalšom nasadení a výpadok by sa vrátil.
- Nový `scripts/uptime-check.sh` — vonkajší monitor oboch verejných adries,
  systemd `--user` timer NA DEV1 (`forestshop-uptime-check.timer`, 5 min
  cadence, nainštalovaný ručne mimo repa — rovnaký vzor ako
  `parovanie-backup.timer`). Confirm-threshold 2, throttle 12 prechodov
  (~1h), + recovery správa. Alert cez `airuleset.py notify --body ...
  --owner-name marek`.
- Naživo overené VŠETKY vetvy rozhodovacej logiky (below-threshold,
  confirm+skutočný alert doručený — `notify-delivery.log` `sent`,
  throttle-suppress, recovery) — pozri PR popis / issue komentár.
- Playbook: `.claude/rules/deploy.md` (nová sekcia — Error 1033 diagnostika +
  oprava + monitor).
- Issue 357 zavretý s dôkazom po merge/nasadení.

## issue 359 — Zrušiť obdĺžnik „Zbaliť menu“, presunúť na šípky vpravo hore v hlavičke menu

- `a15c17b` chore: bump verzie na 0.3.0-dev.215 (0.3.0-dev.214 obsadené
  neschváleným issue 358 + stash-om).
- `ab2327f` feat: prepínač zbalenia presunutý zo samostatného celoširokého
  obdĺžnika pod hlavičkou dovnútra `.brand`, ako 28×28px ikona bez rámu/
  textu vpravo hore vedľa loga/názvu appky (`.brand`'s `justify-content:
  space-between`); logo+text zabalené do nového `.brand-id`. Funkcia
  (localStorage, `aria-expanded`, klik, auto-zbalenie na úzkej obrazovke)
  bit-identická — overené existujúcou sadou bezo zmeny.
  RED->GREEN regresný test: `Sidebar.test.tsx` "prepínač zbalenia je vždy
  len ikona (bez viditeľného textu 'Zbaliť menu'), žijúca v hlavičke vedľa
  loga" — padal proti pôvodnému kódu (span s textom "Zbaliť menu" nájdený),
  prešiel proti `ab2327f`.
- `0596e4d` review: nezávislý review dispatch našiel 1 zistenie (rail móde
  72px `.brand` by pretiekol o ~2px kvôli zdedenému `gap` fungujúcemu ako
  minimum aj pod `space-between`) — opravené `gap: 0` v rail móde, naživo
  premerané (`scrollWidth === clientWidth`).
- `9cfc204` docs: playbook zápis (`.claude/rules/frontend-design.md`) — gap
  ako minimálna medzera pod `space-between`.
- Pull request do vetvy dev (branch issue-359-collapse-icon), CI zelené
  (5/5 SUCCESS), mergeable, mergeStateStatus CLEAN.
- ZAMERNE NEZLUCENE, NENASADENE, tiket ostava otvoreny — nasadenie je
  zmrazene kvoli issue 366 (produkcia presunuta z dev2 neautorizovanym
  agentom, CI deploy job stale mieri na dev2). Merge/nasadenie/zavretie
  tiketu caka na rozhodnutie majitela o issue 366.

## Issue 366 — nasadzovanie z CI mierilo na dev2, hoci produkcia beží na novom serveri (12. 8. 2026)

- PR #373: https://github.com/zbynekdrlik/forestshop-app/pull/373 — merge
  `0d76943`.
- Commits na dev: `b80eb73` (verzia 0.3.0-dev.216), `178dd9a` (runs-on +
  LIVE_HOSTNAME + deploy.md/CLAUDE.md/sensitive-values.md), `bb89bd7`
  (pridaný `scripts/backup-db-local.sh` + review fixy), `9e79cb1`
  (no-test bypass poznámka).
- Príčina: neschválený agent 12. 8. presunul produkciu z dev2 na vyhradený
  Hetzner VPS `forestshop-dev` (178.105.89.168) mimo bežného PR procesu.
  `deploy.yml` stále cieľom `runs-on: [self-hosted, dev2]` — ďalší merge do
  `main` by nasadil do prázdna.
- `runs-on` → `[self-hosted, forestshop-dev]` (runner tam bol už
  zaregistrovaný a bežal, len overený, nie znovu zaregistrovaný).
  `LIVE_HOSTNAME` → `forestshop.newlevel.media` (issue #5 nezávisle overené
  ako reálne vyriešené už 3. 8. 2026, cez Cloudflare API + DNS
  `modified_on`/komentár — nesúvisí s dnešným presunom).
- Nezávislý review (fresh-context subagent) našiel 🔴: `deploy.yml`'s
  `rsync -a --delete` do `/srv/forestshop/scripts/` by prvým nasadením
  zmazal `backup-db-local.sh` (existoval len na serveri, nie v repe) —
  opravené pridaním súboru do repa PRED mergom.
- Po merge zlyhal `deploy` job prvýkrát: `node: command not found` v kroku
  "Overiť verziu na živej stránke" — nový runner (`forestshop-dev-runner`)
  nemal systémovo nainštalovaný Node.js (dev2's runner ho mal). Samotné
  nasadenie (pull/up -d) PREBEHLO úspešne, zlyhal len overovací krok.
  Root-cause fix: `sudo apt-get install -y nodejs` (NodeSource, v24) na
  `forestshop-dev`, reštart runner služby, `gh run rerun --failed` → zelené.
- Naživo overené: `/api/version` na OBOCH hostnames (`forestshop.
  newlevel.media`, `forestshop-novy.newlevel.media`) vracia
  `0.3.0-dev.216` / `0d76943`; `docker ps` na serveri potvrdzuje rovnaký
  image tag. Frontend číta verziu runtime cez `/api/version` (žiadny
  build-time baked string), takže DOM zobrazí presne to, čo API vrátilo —
  Playwright MCP nebol v tejto relácii dostupný, overenie preto išlo cez
  zdrojový kód + curl namiesto vizuálneho screenshotu.
- Staré `dev2-forestshop` runner ostáva zaregistrovaný, nečinný, ako
  rollback cesta (rozhodnutie podľa zadania tiketu).
- Vedľajšie nálezy založené ako issue 369 (osirelý dev postgres kontajner +
  zvyškové dump súbory), issue 371 (5 ďalších playbook súborov so
  zastaranými dev2 príkazmi), issue 372 (backups.md stále rámcuje dev2 ako
  hlavné zálohovanie).
- Playbook: `.claude/rules/deploy.md` (kompletne prepísaná sekcia o cieli
  nasadenia + runner + hostname), `.claude/rules/backups.md` (nová
  zálohovacia varianta pre forestshop-dev).
- Issue 366 zavretý ručne po naživo overení (nie cez `Closes #N` v PR —
  overenie prišlo AŽ po merge/deploy).

## Issue 403 — Úlohy na dnes: naživo pomenované problémy + prerobenie hustoty/ovládania

- Naživo overené na produkcii (Playwright, `vychod@varos.sk`, 11 úloh):
  4 pomenované problémy (komentár na tickete) — falošný Unicode ☐/☑
  checkbox namiesto skutočného `<input>`, priemerná mŕtva medzera 771px
  medzi textom a ikonami (`.uloha-text` neohraničený `flex:1 1 auto` cez
  celú stránku), žiadna vizuálna hranica zoznamu, checkbox/ikony
  center-ované voči celému zalomenému textu na užšom okne namiesto
  prvého riadku. Počet klikov na bežné úkony bol už predtým minimálny —
  potvrdené, nemenené.
- Fix: `commit 5e6b7eb` — `.ulohy-panel` (max-width 40rem, ustálený vzor
  `.ord-supplier-link-edit`), skutočný `<input type="checkbox">` namiesto
  `<button>`u, `.uloha-row`'s `align-items: flex-start`. Cestou nájdený
  SKUTOČNÝ bug: bare `.uloha-done-toggle` prehrával špecificitou proti
  globálnemu `input:not([type="hidden"])` resetu (width:100%) — checkbox
  kradol takmer celú šírku riadku, `.uloha-text` mal vypočítanú šírku 0px.
  Fix: `.uloha-row .uloha-done-toggle` (vyššia špecificita).
- Merané PRED→PO (1440px, 11 úloh, Range-nad-textovým-uzlom metodika):
  priemerná mŕtva medzera 771px → 327px (-58 %), checkbox 13.5×15px
  Unicode glyph → 18×18px skutočný `<input>`, riadková výška nezmenená
  30-31px, panel šírka 640px (predtým neohraničená ~1072px).
  `commit 033f3be` — review dispatch našiel 2 🔵 (chýbajúci komentár na
  `:hover`, nepresné tvrdenie o precedente) — oba opravené.
- Testy: nový vitest regresný test na `role=checkbox`+`checked` (overený
  RED proti starému `<button>` markupu cez review dispatch); `daily-tasks
  .spec.ts` aktualizovaný na `getByRole("checkbox", ...)`. Celá
  web+api unit sada (887+610) aj celá lokálna e2e sada (59/59) zelené.
- **Vedľajší nález (nie tejto zmeny bug, ale AKTÍVNY súbežný jav počas
  tejto relácie):** dva po sebe idúce lokálne e2e behy proti zdieľanej
  `forestshop_app-postgres-1` (5433) zlyhali z dôvodov NESÚVISIACICH s
  týmto diffom — súbežné worktree relácie (issues 397/400) races-ovali
  `scripts/e2e-setup.ts`'s nezamknutý TRUNCATE. Vyriešené izolovanou
  throwaway `docker run postgres:18` inštanciou (port 5555) namiesto
  čakania na tiché okno — 59/59 zelené. Playbook: `.claude/rules/
  local-dev.md` (izolovaná Postgres technika), `.claude/rules/
  frontend-design.md` (CSS špecificita vs. globálny `input` reset).
- Worktree mode (izolácia #317) — commit ostáva na vlastnej vetve,
  supervisor mergne + spustí CI pri round-integrácii.

## Issue 407 — Na objednanie: súhrnné čísla nesedeli so Shoptetom

- Root cause naživo overený proti produkčnej DB (`docker exec
  forestshop-postgres-1`, box je priamo `forestshop-dev`): appka počítala
  "Týždeň"/"Mesiac" ako KALENDÁRNE okná (appky pôvodné čísla presne sedeli
  s kalendárnym výpočtom), Shoptet ich ráta KĹZAVÉ (`now - 7 dní`/`now - 1
  kalendárny mesiac`) — binárnym hľadaním hranice v DB sa dokázalo na cent
  presne (49 obj/4868€, 171 obj/14767€). "Dnes" ostáva kalendárny deň
  (Shoptetova samostatná "24 hodín" dlaždica to naživo dokazuje). Navyše
  "Stornovaná" objednávky sa už do počtu nezarátavajú (explicitný filter,
  aj keď na tržbu v dnešných dátach nemal vplyv — všetky storno majú
  `total_price_with_vat=0.00`). Import je kompletný (čísla po oprave
  presne sedia so Shoptetom, žiadna medzera v `shop_order`).
- Commits: `e70020b` (test: RED), `79c0439` (fix: rolling okná + storno
  filter, `computeBratislavaPeriodBoundaries` → `computeOrdersDashboardBoundaries`),
  `3602dd6` (fix: review nález — mesačná hranica v miestnom, nie UTC
  kalendári; `subtractOneMonthClamped` teraz cez zdieľanú
  `getZonedDateParts`).
- RED→GREEN: `overview.test.ts` (15 testov, 8 RED proti nezmenenej
  implementácii) + `orders-overview.integration.test.ts` (9 testov,
  storno-exclusion + inclusive-boundary testy).
- Independent review dispatch: 0 🔴 2 🟡 2 🔵 → oba 🟡 opravené (UTC vs.
  miestny kalendár pri mesačnej hranici; zastarané playbook odkazy),
  oba 🔵 vyriešené (krížový komentár k duplicitnému `STORNO_STATUS_NAME`;
  odstránený redundantný test).
- Testy: unit 889 (api) + 599 (web), integration 94 súborov/717 testov,
  lokálna e2e sada 55/55 — všetky zelené po oprave.
- Playbook: `.claude/rules/orders.md` (prepísaná dashboard sekcia — nová
  issue 407 sekcia + `subtractOneMonthClamped` clamp/DST poznámka + Node-
  skript verifikačná technika pre mesačnú aritmetiku), `.claude/rules/
  testing.md` (RED-pred-GREEN technika pre premenuj+zmeň-správanie fix
  cez dočasný `git show HEAD:` revert implementácie).
- Worktree mode (izolácia #317) — commit ostáva na vlastnej vetve,
  supervisor mergne + spustí CI pri round-integrácii.
## Issue 412 — Na objednanie: zmenená objednávka v Shoptete stále ukazuje starý produkt

- Root cause naživo overený proti produkčnej DB (`docker exec
  forestshop-postgres-1`) VS. aktuálnemu živému Shoptet exportu (stiahnutý
  priamo cez skompilovanú `fetcher.ts`/`parser.ts` cestu z bežiaceho
  `forestshop-app-1` kontajnera, žiadny hash/URL nikde vypísaný): objednávka
  20261306 mala v DB 8 `order_line` riadkov, aktuálny export niesol len 6
  reálnych — `61729/M` ("Flisová bunda Percussion Scotland - zelená M",
  presne produkt zo screenshotu) a `40674/S` boli STARÉ, dávno vymenené
  produkty, ktoré Shoptet už vôbec nehlási. `ingestOrders`'s `order_line`
  upsert (keyed `(order_id, variant_code)`) NOVÝ produkt vždy pridal, ale
  STARÝ riadok nikdy nezmazal.
- Design comment (root cause/3 zvážené prístupy/FK prieskum) PRED prvým
  code commitom:
  https://github.com/zbynekdrlik/forestshop-app/issues/412#issuecomment-5278871919
- Commits: `e3f527c` (chore: version bump .243), `e550fc8` (test: RED),
  `d3a1650` (fix: GREEN — cielený reconciliation DELETE po existujúcom
  upsert cykle), `6941896` (chore: fixture fixy pre nové
  `deletedStaleLineCount` pole + rozdelenie test súboru pod eslint
  `max-lines`), `21be123` (refactor: review nálezy — dávkovaný set-based
  DELETE cez `chunk()`, zdokumentované poradie zamykania).
- RED→GREEN: `orders-ingest.integration.test.ts`'s "re-import ODSTRÁNI
  riadok produktu, ktorý Shoptet z objednávky vymenil, a zachová stav
  nezmeneného súrodeneckého riadku" — RED zlyhal na `e550fc8` (3 riadky
  namiesto 2), GREEN prešiel na `d3a1650`. Test dokazuje OBOJE naraz:
  vymenený produkt sa nahradí (starý zmizne, nový má predvolený stav) A
  súrodenecký nezmenený riadok si zachová manažérom nastavený stav
  (dôkaz, že reconciliation je cielený, nie plný replace objednávky).
- Independent review dispatch (fresh general-purpose subagent, celý diff +
  priama kontrola schema/adjacent modulov): 0 🔴 2 🟡 1 🔵 — batching
  (dávkovaný DELETE namiesto po-jednej-objednávke) a teoretický (nie
  novozavedený) lock-ordering vzor s `setSupplierLinesOrdered`
  zdokumentované v `21be123`; vyhradený deterministický deadlock-regresný
  test presahuje rozsah tohto bugfixu, filed as #416.
- Testy: unit 962 (api) + 602 (web), integration 98 súborov/745 testov (2×
  zelené, pred aj po review-fixe), lokálna e2e sada 55/55 — všetky zelené.
  Izolovaný throwaway Postgres (vlastný kontajner, nie zdieľaný
  `forestshop-postgres-1`/`forestshop_app-postgres-1` port 5433) —
  `forestshop-dev` je zdieľaný 2-CPU box aj s produkciou.
- Playbook: `.claude/rules/orders.md` (nová #412 sekcia — mazacia logika,
  FK prieskum, poradie zamykania), `.claude/rules/local-dev.md` (nový
  gotcha — `vitest`/esbuild vo worktree si vie "koreň" nájsť až v
  hlavnom checkoute, keď supervisor práve integruje súbežnú vetvu).
- Worktree mode (izolácia #317) — commit ostáva na vlastnej vetve,
  supervisor mergne + spustí CI pri round-integrácii.
## 2026-08-13 — #398 + #401 + #409 (Parovanie: vsetky moznosti na karte, plna populacia, obrazky v paneli)

- Batch (worktree isolation, #317), version bump `d504053` (0.3.0-dev.239→.241).
- Design comment BEFORE first code commit (root cause/pristup/zamietnuta
  alternativa/Architektura, spolocny pre vsetky tri tikety):
  https://github.com/zbynekdrlik/forestshop-app/issues/398#issuecomment-5278355746
  (link z #401/#409).
- Implementacia `3779235`:
  - #398: `PairingReviewCard.tsx` — zrusenie "Zle" medzikroku, kolektivny
    riadok (Dobre/vyber url/Nie skladom/Uz nepredava) priamo na karte,
    vysvetlujuca poznamka pri terminalnom rozhodnuti (nocna automatika),
    filtre rozsirene o "decided"/"terminal" (API zod enum + web).
  - #401: `queries.ts`'s `listPairingReview` — populacia = unia (ma
    candidate_set RIADOK, ALEBO nema efektivnu linku, ALEBO ma
    pairing_decision riadok), nove pole `supplierHasAdapter`, `gatheredAt`
    nullable.
  - #409: `listPairingCandidatesForProduct` vracia `imageUrl` pre kazdeho
    z top-8 (uz perzistovane z gather behu, ziadny live-fetch).
  - Novy subor `PairingReviewPanelParts.tsx` (extrakcia `TerminalButtons`/
    `PanelCandidateRow` — eslint `max-lines: 400`).
- Review (`fa22d5d`, jeden samostatny `general-purpose` subagent nad celym
  diffom): 2 🟡 opravene — auto-show panel nikdy nevolal
  `fetchPairingCandidates` (bug od E6, #401 ho spravil bezneho), stary
  intro odstavec tvrdil "rozhodovanie pride neskor".
- Testy: unit (web `PairingReviewCard.test.tsx`/`PairingReviewSection
  .test.tsx`, +regresny test na auto-fetch), integration (2 nove testy v
  `pairing-review-http.integration.test.ts` pre plnu populaciu +
  `supplierHasAdapter`, 2 nove v `-decisions-http` pre rozhodnutie na
  produkte bez candidateSet), e2e (2 nove testy — E2E-PR-BEZADAPTERA,
  E2E-PR-PANEL, + 3 existujuce testy rozsirene). Cely lokalny beh (web
  607/607, api 960/960 unit + 744/744 integration, e2e 57/57) zeleny —
  izolovany throwaway Postgres (port 5442→5443), box zdielany s inymi
  worktree workermi (forestshop-dev).
- Playbook: `.claude/rules/pairing-search.md` — nova sekcia "issues
  398/401/409" (populacna unia, `supplierHasAdapter` vs. gather stav,
  `suppliers` TRUNCATE-bez-reseedu past, auto-show fetch gotcha, zdielany
  testid vzor).
- Worktree mode (izolacia #317) — commit ostava na vlastnej vetve,
  supervisor mergne + spusti CI pri round-integracii.

## Issue 410 — Objednávky predajňa: nahradiť Shoptet zoznam vlastnými zápismi z predajne

- Nahrádza Shoptet-viazanú obrazovku (issue 345) vlastnou nástenkou zápisov z predajne
  (Štěpánovo Discord vlákno). Commity: `8695a4d` (verzia 0.3.0-dev.240), `46b8c6a` (feat —
  schéma `floor_note`/`floor_note_product` (migrácia `0051_nasty_garia.sql`, pôvodne, viď
  nižšie), `apps/api/src/modules/floor-notes/{queries,service}.ts`,
  `floor-notes-routes.ts`, `FloorNotesSection.tsx`/`FloorNoteRow.tsx`/
  `FloorNoteProductSearch.tsx`, `floorNotesApi.ts`, `autoResizeTextarea.ts`, staré
  `floor-orders-*` odstránené), `d82387d` (merge origin/dev — renumbering na `0052_
  thankful_invisible_woman.sql` po kolízii s issue 397's `0051_dusty_marrow.sql`, plný
  postup v `.claude/rules/database.md`), `3faed72` (review-fix testy: priama DB kontrola
  cascade delete + regresný test na variantový kód s `/`).
- Design komentár PRED prvým kódom:
  https://github.com/zbynekdrlik/forestshop-app/issues/410#issuecomment-5278232200
  (Triage: non-trivial, 3 zvážené prístupy, Architektúra sekcia). STEP 0 validácia:
  https://github.com/zbynekdrlik/forestshop-app/issues/410#issuecomment-5278226924.
  Review pass (fresh-context general-purpose subagent, 0🔴0🟡3🔵, všetky 3 opravené):
  https://github.com/zbynekdrlik/forestshop-app/issues/410#issuecomment-5279065199.
- Testy: nové unit (web: `FloorNotesSection*.test.tsx` ×3, `autoResizeTextarea.test.ts`),
  integration (api: `floor-notes-http.integration.test.ts` 16, `floor-notes-products-http
  .integration.test.ts` 10), e2e (`floor-notes.spec.ts` — plný tok: napísať, pripnúť
  produkt s priamou aj náhradnou adresou, prepnúť značky, upraviť, odopnúť, zmazať).
  `catalog.spec.ts`'s pevné počty zvýšené o 2 (103→105, 73→75) — nová e2e fixtúra vkladá 2
  varianty priamo, rovnaká past ako issue 217/337/atď (`.claude/rules/testing.md`).
- Plný lokálny beh po zlúčení s origin/dev (issue 397's paralelná integrácia): typecheck +
  lint čisté, unit web 614 + api 960 zelené, CELÁ integračná sada 98 súborov/760 testov
  zelená, CELÁ e2e sada 55/55 zelená (2 behy — druhý po oprave `catalog.spec.ts`'s počtov).
  Overené na izolovanej throwaway Postgres inštancii (port 5440), nie na zdieľanej 5433 —
  paralelný worktree (issue 397) bežal súbežne na tomto boxe.
- Playbook: nový `.claude/rules/floor-notes.md` (celý dizajn + gotchas), addendum do
  `.claude/rules/database.md` (druhý overený výskyt migračnej kolízie — REGENEROVAŤ cez
  `db:generate`, nie ručne splicovať snapshot JSON; pasca so zabudnutým provizórnym
  journal záznamom).
- Worktree mode (#317) — commit ostáva na vlastnej vetve `worktree-agent-aeefd434be27ba402`,
  supervisor mergne priamo z tejto REF-y a spustí CI pri round-integrácii.

## Issue 413 — run-now joby: async 202 + advisory try-lock, orphaned job_run cleanup pri štarte

- Salvage worker (predošlý worker zomrel na session limit, práca ostala necommitnutá v
  existujúcom worktree `worktree-agent-a702ceb9bd8f82553`). Verzia zlúčená na 0.3.0-dev.248
  (merge `4c5927b` — dev medzitým postúpil na .247 issue 412's integráciou; konflikt
  vyriešený priamo na .248, žiadny amend).
- Design komentár + STEP 0 validácia (obe posunuté PRED prvým code commitom, oba PÔVODNÝM
  workerom): https://github.com/zbynekdrlik/forestshop-app/issues/413#issuecomment-5279794989
  (validácia) a https://github.com/zbynekdrlik/forestshop-app/issues/413#issuecomment-5279795618
  (Triage: non-trivial, 3 zvážené prístupy, Architektúra sekcia).
- Jadro (commity `568bb65` RED / `f29cd77` GREEN): nový zdieľaný `modules/scheduler/
  run-now.ts`'s `startRunNow` — `pg_try_advisory_lock` (neblokujúci), busy=200 bez zápisu,
  acquired=202 hneď + fire-and-forget `job.run()` (držiaci zámok po celý beh, uvoľní sa až
  v `.finally()`). Všetkých šesť `run.ts` súborov (`shop-sitemap`/`pairing-search`/
  `posta-uncollected`/`order-reminder`/`supplier-stock`/`restock`) exportuje svoj interný
  "Locked" variant; `http/*-routes.ts` nahradili vlastnú kópiu `runAndRecord` volaním
  `startRunNow`. Naplánovaný beh (`scheduler/jobs.ts`) beží nezmenene cez pôvodný `runXxx()`.
  Frontend: nový `apps/web/src/pollJobRun.ts`'s `pollUntilJobDone` (exponenciálny backoff,
  ~2 min strop) namiesto priameho čítania POST odpovede, na 4 obrazovkách s tlačidlom.
  Osirotené `job_run` riadky: nový `modules/scheduler/startup-cleanup.ts`'s
  `cleanOrphanedJobRuns`, volaná raz z `index.ts` hneď po migráciách.
- Vlastný review nález počas salvage (commity `0bbb6ee` RED / `3801692` GREEN, `37d8061`
  lint-fix): `db.insert(jobRuns)` vkladajúci "running" riadok nemal `try/catch` — zlyhanie by
  nechalo advisory zámok navždy držaný (aj pre naplánovaný beh s tým istým kľúčom). RED→GREEN
  overené priamo (dočasné odstránenie fixu → beh → hang/cascade timeout na ďalších testoch v
  súbore → fix vrátený → 5/5 čisto).
- Nezávislý fresh-context `general-purpose` review dispatch (rozsah `4c5927b..HEAD`, opravený
  cez `SendMessage` po počiatočnom zlom `cc4ba84..HEAD` rozsahu, čo omylom zahŕňal issue 412's
  zlúčenú prácu): 0🔴, 2🟡 (oba opravené), 2🔵 (pred-existujúce, nedotknuté). 🟡#1 (commity
  `3c977f5` RED / `19c7999` GREEN): zápis KONEČNÉHO stavu (`db.update` v `.then()`u) mohol
  zlyhať a nechať riadok navždy "running" — fix `writeTerminalOutcome` s núdzovým `failure`
  zápisom. 🟡#2 (commit `1fb856d`): len 2 zo 6 trás mali HTTP-úrovňový test na 202/busy
  kontrakt — doplnené 3 nové súbory (`restock`/`shop-sitemap`/`pairing-search`-run-now-http)
  + rozšírený `supplier-stock-http.integration.test.ts`, všetky proti PRÁZDNEJ DB (každá
  business funkcia má vlastný "0 kandidátov" skorý návrat pred prvým dotykom reálnej externej
  závislosti — overené priamo v zdroji, nie predpokladom). Review komentár:
  https://github.com/zbynekdrlik/forestshop-app/issues/413#issuecomment-5281136318 (aj s
  poznámkou, že design komentár spomína 409 pre busy — implementácia správne skončila na 200,
  `.claude/rules/testing.md`'s konvencia).
- Plný lokálny beh na FINÁLNOM commitnutom stave: typecheck + lint čisté, unit web 630 + api
  962 zelené, CELÁ integračná sada 104 súborov/786 testov zelená (2 nezávislé behy), CELÁ e2e
  sada 57/57 zelená (2 behy). Overené na izolovanej throwaway Postgres inštancii (port 5440).
- Playbook: addendum do `.claude/rules/scheduler.md` (zámok-medzi-acquire-a-finally
  disciplína — KAŽDÝ krok potrebuje vlastný try/catch; prázdna-DB HTTP test vzor pre run-now)
  a `.claude/rules/local-dev.md` (dvojbodkový `git diff A..B` cez merge commit zahŕňa cudziu
  prácu — over `git log --oneline A..B` najprv).
- Worktree mode (#317) — commit ostáva na vlastnej vetve `worktree-agent-a702ceb9bd8f82553`,
  supervisor mergne priamo z tejto REF-y a spustí CI pri round-integrácii. Throwaway Postgres
  kontajner (`agent-a702ceb9-pg`, port 5440) odstránený na konci.

## Issues 416 + 405 (2026-08-13, worktree agent-a5e9dfcc17ee273e4)

- Verzia: `0.3.0-dev.249` (commit `b33e356`).
- **Issue 416** (teoretický deadlock: `ingestOrders`'s reconciliation DELETE
  vs. `setSupplierLinesOrdered`'s bulk `.for("update")` JOIN, review nález na
  issue 412): design komentár (Triage: netriviálne, 3 zvážené prístupy,
  Architektúra sekcia) na tickete PRED kódom. Nový test
  `tests/orders-ingest-supplier-bulk-deadlock.integration.test.ts` (commit
  `d9ebcce`) — DETERMINISTICKY orchestruje skutočný AB-BA cyklus (druhé
  pripojenie zamkne `order_line` PRED `order`, reálny `ingestOrders` sa
  zasekne naň, druhé pripojenie sa POTOM zaseknutím na `order` samo zacyklí)
  cez dve nové pomôcky (`findBackendBlockedBy`/`waitUntilBlockedBy`,
  `pg_blocking_pids` polling, rovnaká technika ako `orders-supplier-bulk-
  lock.integration.test.ts`). 5/5 lokálnych behov: Postgresov deadlock
  detektor vyrieši cyklus vždy do ~1.2s, kód `40P01`, DB ostáva konzistentná
  (žiadny čiastočný zápis) bez ohľadu na to, ktorá strana bola obeťou. Žiadna
  zmena produkčného kódu — appka to už bezpečne zvláda (outer catch/rethrow +
  Postgresova transakčná atomicita).
- **Issue 405** (flaky `shoptet-writeback-sequence.integration.test.ts`'s
  "state writeback enabled" test, dva rôzne nahlásené tvary zlyhania): design
  komentár (Triage: triviálne) na tickete pred akoukoľvek zmenou. Príčina
  identifikovaná analyticky (`isStateWritebackEnabled`'s fail-closed `row?.
  enabled ?? false` + `link?.syncedAt` čítaný AŽ po celej ~30s sekvencii —
  dosť dlhé okno pre súbežný `scripts/e2e-setup.ts`'s nezamknutý TRUNCATE z
  iného worktree) a POTVRDENÁ DELIBERÉRNOU reprodukciou na vlastnej throwaway
  Postgres inštancii: timovaný `docker exec ... psql -c "TRUNCATE TABLE
  pairing_state_writeback_settings;"` (~6s do behu) dal presne prvý nahlásený
  tvar zlyhania (`state:{status:'disabled'}`), `TRUNCATE TABLE product_
  supplier_link_override` (~20s do behu) dal presne druhý (`link?.syncedAt`
  undefined). 4x čistý izolovaný beh (žiadna kolízia) — 0 flakov. Žiadna
  zmena kódu — čisto dokumentačný commit (`49b3b21`).
- Nezávislý fresh-context `general-purpose` review dispatch (rozsah
  `origin/dev..HEAD`): pozri report nižšie / na tickete.
- Plný lokálny beh na izolovanej throwaway Postgres inštancii (port 5440):
  typecheck + lint čisté, unit web 630 + api 962 zelené, CELÁ integračná
  sada 105 súborov / 787 testov zelená (vrátane nového deadlock testu),
  CELÁ e2e sada 57/57 zelená.
- Playbook: `.claude/rules/shoptet-writeback.md` (presný symptóm-podpis
  oboch nahlásených zlyhaní pre budúcu session), `.claude/rules/local-dev.md`
  (technika deliberérnej TRUNCATE reprodukcie na throwaway inštancii + cielené
  spustenie jedného vitest súboru/testu cez `exec vitest run ... -t`),
  `.claude/rules/database.md` (technika orchestrácie skutočného obojsmerného
  deadlock cyklu, nie len jednosmerného TOCTOU čakania).
- Worktree mode (izolácia, viď skoršie záznamy vyššie v tomto súbore) —
  commity ostávajú na vlastnej vetve `worktree-agent-a5e9dfcc17ee273e4`,
  supervisor mergne priamo z tejto REF-y a spustí CI pri round-integrácii.
  Throwaway Postgres kontajner (`agent-a5e9dfcc17ee273e4-pg`, port 5440)
  odstránený na konci.
