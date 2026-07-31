---
paths:
  - "apps/web/src/**"
  - "apps/web/src/styles/**"
---

# Frontend design (visual foundation, issue 57)

- **The legacy app (`parovanie_produktov`) is a reference for BEHAVIOUR/functionality
  only — NEVER for looks.** The owner explicitly rejected copying its visual
  design ("stará appka je hrozná, navrhni to lepšie"). A prior in-flight
  attempt (never committed) had literally copied its CSS values into
  `app.css` — corrected before merge. When unsure what a screen must DO, read
  the legacy app; when deciding how it should LOOK, use this app's own tokens
  below and make an original, good design.
- **Design tokens live in `apps/web/src/styles/app.css`'s `:root`** —
  `--fs-*` custom properties for color, typography scale, spacing (4px
  base), radius, shadow. New screens/components MUST reuse these tokens
  (`var(--fs-brand)`, `var(--fs-space-4)`, …), never introduce a new raw hex
  color or px value that duplicates an existing token's intent. Generic
  element resets (`table`, `button`, `input`, `label`, `h1-h3`,
  `[role=alert]`/`[role=status]`) in the same file give even HIDDEN screens
  (below) a consistent baseline without touching their TSX.
- **Nav registry (`apps/web/src/nav.ts`) — `NAV` (visible sidebar
  folders/tabs) vs. `HIDDEN_TABS` (still coded + tested, reachable only via
  `?tab=<id>`, no sidebar entry).** Adding a new VISIBLE tab = one entry in
  `NAV`, no `App.tsx`/`Sidebar.tsx` change needed. Moving a tab from hidden
  to visible = move its entry from `HIDDEN_TABS` to a `NAV` folder — the
  component itself needs no change (`findTab`/`isVisibleTabId` already
  handle both).
- **User account controls (greeting/logout/change-password) live in
  `Topbar.tsx` as a dropdown "user menu" in the HEADER — not the sidebar
  footer.** This was an explicit ticket decision (#57): "change-password
  must stay reachable, e.g. via a user menu in the header." Click the
  signed-in user's name (`data-testid="greeting"`) to open/close the panel;
  `passwordPanelOpen` is lifted to `App.tsx` (decides whether
  `ChangePasswordForm` renders), the menu's own open/closed state is local
  to `Topbar`. E2E tests interacting with "Zmeniť heslo"/"Odhlásiť" must
  click the greeting first to open the menu.
- **`scripts/e2e-setup.ts` always seeds two real open orders** (variant
  `4859/46` under supplier `DODAVATEL-TEST-1`, variant `40287` with no
  supplier) — a NEW e2e test must never assert the "Na objednanie" screen is
  empty; assert the real seeded supplier group instead
  (`getByTestId("supplier-DODAVATEL-TEST-1")`).
- **Adding a new e2e spec file with its own logins under the SHARED
  `e2e@forestshop.sk` account risks overflowing `MAX_ATTEMPTS=10` in
  `login-rate-limit.ts`** (5-minute window, shared across the whole e2e run
  since all spec files hit one long-lived API server process) — count the
  running total across ALL spec files before adding more logins to the
  shared account; if it would exceed 10, add your OWN isolated seeded
  account in `scripts/e2e-setup.ts` (same pattern as
  `E2E_HESLO_ZMENA_EMAIL`/`E2E_SKUPINY_EMAIL`/`E2E_NAV_EMAIL`) rather than
  reusing the shared one. Exceeding it shows up as an unrelated-looking
  "Nesprávny e-mail alebo heslo" on a RANDOM later test in the same run, not
  a rate-limit-specific error (the client's `postLogin()` collapses every
  non-2xx response, including 429, to the same generic failure).
- **A component file that grows past eslint's `max-lines: 400` after adding a
  feature gets its TABLE ROW / list-item rendering extracted into its own
  component file, not trimmed by removing comments/whitespace.** Issue 60
  added a checkbox column + a renamed header to `OrdersSection.tsx`, pushing
  it to 454 lines — extracted the `<tr>` body (plus the `STATE_LABELS` map it
  alone uses) into `OrderLineRow.tsx`, taking `line`/`canChangeState`/busy-flag
  props and two callbacks (`onChangeState`/`onChangeOrdered`) from the parent,
  which stayed the state/data-fetching owner. Same principle as the
  established test-file split pattern (`orders-http.integration.test.ts` /
  `orders-http-state.integration.test.ts`) — when a component crosses the
  cap, pull out the REPEATED per-item rendering unit first; it is almost
  always the largest, most self-contained slice.
- **A per-item busy-guard vs. a group busy-guard needs to be disabled in
  BOTH directions, or it will be found missing one at a time.** Issue 60's
  "objednané" checkbox (per-row) + group toggle button pair got this fix
  TWICE: review of PR 75 finding 6 disabled the per-row checkbox while the
  group's own bulk write (`busyOrderedSupplier`) was in flight, and review
  of PR 76 finding 5 then had to add the MIRROR — disabling the group
  button while a per-row write (`busyOrderedLineId`) for a line IN that
  group was in flight (`group.lines.some((l) => l.lineId ===
  busyOrderedLineId)`, `OrdersSection.tsx`). Both directions matter because
  either write can complete after the other and repaint the same rows with
  a stale computed value — no data loss (last write to the DB still wins),
  but confusing UI. When adding ANY new busy-flag pair like this (an
  individual-item action + a group/bulk action touching the same items),
  add BOTH disables in the SAME change, don't wait for a second review pass
  to catch the missing direction.
- **A `useEffect` that syncs local state FROM a prop (`setSupplierDraft(line
  .manualSupplierOverride ?? "")` in `OrderLineRow.tsx`, issue 63) ALSO
  fires on the component's very first MOUNT** — `useEffect` always runs
  once after the first commit regardless of whether its dependency
  "actually changed", and the `useState` initializer right above it
  ALREADY captures that same starting value, making the mount-time firing
  pure redundancy. That redundant firing is not just wasted work: it is a
  RACE, because it is scheduled as a passive effect and may not flush
  before a fast interaction that happens right after the row first
  appears (issue 89, found by a brand-new test that was the first thing
  in this codebase to interact with this exact field — reproduced at
  ~1-in-150 in a local stress loop, and it flaked once for real on main's
  CI). Fixed with a `useRef` "skip the first run" guard so the effect only
  fires on a genuine LATER change of the watched prop. Any NEW
  prop-syncing `useEffect` added to a row/item component in this codebase
  needs the same guard UNLESS the mount-time run is provably harmless
  (i.e. truly a no-op, not just usually fast enough to lose the race).
- **This project's vitest setup has NO `@testing-library/jest-dom`
  matchers wired up** — `expect(input).toHaveValue(x)` /
  `expect(checkbox).toBeChecked()` fail with `Invalid Chai property`, not
  a normal assertion failure. Existing tests already avoid this
  (`checkbox.checked`, plain property reads) — a NEW test needing to
  assert a controlled input's value must read `(input as
  HTMLInputElement).value` directly, never reach for a jest-dom matcher.
- **`fireEvent.change(input, ...)` immediately followed by
  `fireEvent.keyDown(input, { key: "Enter" })` in the SAME synchronous
  block is measurably flaky** (issue 89: ~1-in-8 local runs never
  triggered the Enter handler's save call at all). The established,
  reliable pattern already used elsewhere in this file (the "e-mail
  dodávateľa" test) is `fireEvent.change` followed by `fireEvent.click`
  on the actual save/submit BUTTON — use that, not a keyDown-Enter
  shortcut, for any new form-field-plus-save-button interaction test.
