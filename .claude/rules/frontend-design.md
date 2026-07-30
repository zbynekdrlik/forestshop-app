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
