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
- **A PRÁZDNY priečinok (`NavFolder` s `tabs: []`) je platný placeholder —
  `Sidebar.tsx` ho vykreslí ako obyčajnú zbaliteľnú hlavičku bez obsahu,
  žiadny viditeľný prázdny box** (`.folder-head` sa renderuje vždy, telo
  `.folder-body`/`.tabs` ostane prázdne a nemá rám ani pozadie). Issue 501
  (nové sekcie „Vyšívanie"/„Slavosport" HNEĎ POD „Eshop", zatiaľ bez funkcií)
  ich pridalo presne takto — jeden `{ id, label, tabs: [] }` záznam v `NAV`,
  žiadna zmena `Sidebar.tsx`/`App.tsx`/CSS. `defaultCollapsed` sa NENASTAVILO
  (štartujú rozbalené ako Dôležité/Eshop), `label` je v prirodzenom tvare
  (CSS `text-transform: uppercase` na `.folder-head` ho zobrazí veľkými
  písmenami — do registra sa píše prirodzený tvar). Keď sa neskôr doplní
  funkcia, stačí pridať záložky do `tabs` toho istého priečinka. **E2E
  overenie PORADIA priečinkov** (nielen prítomnosti jednotlivých hlavičiek):
  `page.locator(".side-nav .folder-head .ftitle").allTextContents()` vráti
  SUROVÝ text priečinkov z registra (CSS `uppercase` neovplyvňuje
  `textContent`), takže sa porovná `toEqual([...])` s očakávaným poradím —
  pozri `nav.spec.ts`. Prázdny priečinok nemá žiadny `.tab`, takže počet
  `.side-nav .tab` sa pridaním prázdnej sekcie NEMENÍ.
- **A VISIBLE tab (in `NAV`, not `HIDDEN_TABS`) must NEVER render its own
  `<h1>`/`<h2>` matching the tab's `label` — `App.tsx` renders that title
  itself via `Topbar` for any `isVisibleTabId(activeTabId)` tab, so a
  component-owned heading duplicates it (`getByRole("heading", {name})`
  then resolves to 2 elements — found live on issue 239's brand-new
  "Párovanie produktov" screen, which shipped with its own `<h2>` because
  it was written as a fresh visible tab, not a hidden-tab migration). The
  existing rule "moving hidden→visible removes the old `<h2>`"
  (`nav.ts`'s own comment, `isVisibleTabId`) applies EQUALLY to a
  brand-NEW visible tab written from scratch — never add a
  `<h1>`/`<h2>` inside a section component whose tab already lives in
  `NAV` (see `OrdersSection.tsx`/`NedostupneSection.tsx`/
  `PostaUncollectedSection.tsx` for the established no-own-heading
  pattern). Only `HIDDEN_TABS` components (`CatalogPage.tsx`/
  `PairingSection.tsx`/`SchedulerSection.tsx`) keep their own heading.
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
- **The "controlled draft reset via `useEffect` + skip-first-mount" pattern
  (established for `supplierDraft`, issue 63) needs an EXTRA "dirty" guard
  when the same prop can change for a reason OTHER than "this row's own
  save resolved".** Issue 64's `commentDraft` in `OrderLineRow.tsx`:
  `line.comment` is shared across every row of the same order
  (`OrdersSection.tsx`'s `changeComment` updates all of them on any one
  row's save), so the reset effect fires on EVERY sibling row too — not
  just the row that actually saved. Without an extra guard, an unsaved
  draft on row A is silently overwritten the moment row B (same order)
  saves. Fix: an `isCommentDirty` ref, set on every keystroke, cleared only
  when THIS row's own save fires; the reset effect skips the reset while
  dirty. Found by code review (`superpowers:requesting-code-review`)
  BEFORE merge, not by a test — the existing propagation test only proved
  the happy path (edit-then-verify-sibling-updates), never two
  simultaneously-dirty drafts. Test on any FUTURE prop-syncing effect of
  this shape: does the same prop change for a reason OTHER than "this
  instance's own action completed"? If yes, "skip first mount" alone is
  not enough — add the dirty guard too (see `.claude/rules/orders.md`'s
  matching entry for the full mechanism).
- **`position: sticky` inside a wrapper that needs `overflow-x: auto` (for a
  wide table's own horizontal scroll) does NOT stick to the viewport — it
  sticks to that wrapper instead, and breaks.** Issue 95 tried a sticky
  `<thead>` on the "Na objednanie" table: `.orders-table-wrap`'s required
  `overflow-x: auto` makes the CSS engine treat the wrapper as a scroll
  container on BOTH axes (the spec's "if one axis is non-`visible`, compute
  the other to `auto` too" rule), which re-anchors the sticky `<th>`'s `top`
  offset to that small, non-scrolling wrapper instead of the page — pushing
  the header down OVER the first row without the table reserving that space
  in its layout. Found by a REAL Playwright run, not by inspection:
  `checkbox.click()` failed with "`<th>Objednané</th>` … intercepts pointer
  events". Any FUTURE sticky-header attempt on a table that also needs its
  own horizontal-scroll wrapper needs a genuinely different layout (a
  separately-positioned header row/element outside the scrolling ancestor,
  not `position: sticky` on `<th>`/`<thead>` inside it) — don't retry the
  same approach.
- **A single-word, ALL-CAPS `<th>` in a narrow `table-layout: fixed` column
  breaks MID-WORD, not at a word boundary, if `overflow-wrap: break-word`
  applies to `<th>`.** Issue 95's checkbox-column header "OBJEDNANÉ" (no
  spaces) wrapped to three lines ("OBJE/DNAN/É") at a 4%-wide column —
  found only by a LIVE post-deploy Playwright check at 1920px, not by any
  automated test (unit tests don't render real column widths; the e2e
  console/scroll-width checks don't inspect visual text wrapping). Fix:
  scope `overflow-wrap: break-word` to `<td>` only (still needed there for
  long product names/comments) — multi-word headers ("Dátum objednávky")
  already wrap fine at their natural space without it — and widen the
  narrow column's `<colgroup>` percentage until the single word fits on one
  line. Any FUTURE narrow single-word column header on this table needs the
  same check: render it at the real column width (not just skim the CSS)
  before shipping.
- **Merging two table columns into one WITHOUT touching any test**: keep
  BOTH original elements (their exact `data-testid`, exact conditional
  rendering logic) as SIBLING nested elements inside the one merged `<td>`,
  instead of combining their JSX/conditions into new markup. Issue 95
  merged VEĽKOSŤ→KÓD (simple inline append, no existing testid to
  preserve), and DODÁVATEĽ+PRIRADENIE DODÁVATEĽA / POZNÁMKA E-SHOPU+KOMENTÁR
  (both had existing `data-testid`s multiple unit/e2e tests already
  targeted) — for the latter two, `OrderLineRow.tsx` renders the ORIGINAL
  two `<div data-testid="...">` blocks, byte-for-byte unchanged rendering
  logic, just nested inside one new `<td>` wrapper instead of two `<td>`s.
  Every existing test kept passing with ZERO test edits. A regression test
  proving a merge is a REAL DOM merge (not just relabeled headers): assert
  the two testid'd elements' `.closest("td")` are the SAME node
  (`OrdersSection.test.tsx`).
- **A flex item's `flex-basis` — NOT its post-shrink rendered size — decides
  whether it fits on the current line under `flex-wrap: wrap`.** Issue 105's
  `.ord-comment-cell`/`.ord-supplier-assign` (issue 63's established pattern:
  `display: flex; flex-wrap: wrap` on the cell so an overflowing input+button
  wraps INSIDE the cell instead of bleeding into the neighbour column) still
  wrapped onto two lines at the table's narrowest real width, making rows
  135px tall — even after giving the `<input>` a `min-width` and relying on
  `flex-shrink`. Root cause: with `width: 8rem/10rem` (fixed) and no `flex`
  shorthand, the item's `flex-basis: auto` resolves to that `width`, and
  **flex-basis is what the wrapping algorithm measures BEFORE any shrinking
  happens** — a large flex-basis wraps regardless of how small `min-width`
  allows the item to actually shrink afterward. Fix: `flex: 1 1 0%` (a ~0
  flex-basis, so the item always "fits" for wrapping purposes) + `flex-grow:
  1` (it then expands to fill whatever room the line actually has) + a small
  `min-width` sized to the WORST-CASE measured column width (never guessed —
  see below) + `flex-shrink: 0` on the sibling button so its tap target never
  shrinks. `flex-wrap: wrap` stays on the parent as a safety net (issue 63's
  original reason), it just stops triggering once the basis is right. Any
  FUTURE flex-wrap cell with a shrinkable input + a fixed sibling (button/
  icon) that still wraps unexpectedly: check whether the shrinkable item has
  `flex: 1 1 0` — a `width`/large `flex-basis` on it is the same trap, no
  matter how small its `min-width` is.
- **A per-row toggle that opens an inline edit control (input+save) must be a
  SIBLING of an existing tested cell div, never nested INSIDE it — and the
  edit form itself must render ONLY while open, not always.** Issue 121
  (manual supplier-LINK override, always-editable — unlike issue 63's
  gated supplier-name assign): `OrderLineRow.tsx`'s existing
  `.ord-supplier-cell` div (testid `supplier-link-${lineId}`) has a test
  asserting its `textContent` is EXACTLY `"—"` for an empty row
  (`OrdersSection.test.tsx`) — putting the new pencil toggle button INSIDE
  that div would have broken it (`"—✏️"` ≠ `"—"`). Fix: wrap the existing,
  UNCHANGED cell div together with the new toggle button in a new
  `.ord-supplier-row` flex-row wrapper (`app.css`), so the toggle is a
  sibling, not a child. Second half of the same fix: the toggle itself is
  ALWAYS rendered (small, `flex-shrink: 0`, adds no height), but the actual
  `<input>+save` block renders ONLY when `linkEditing` is true — an
  always-visible input+button on EVERY row (the `.ord-supplier-assign`
  pattern from issue 63, which IS always-visible but only for the minority
  of `supplierAssignable` rows) would have added height to ALL 34+ non-gated
  rows at once and almost certainly broken the issue 105/107/111/127
  ~120px row-height ceiling. Any FUTURE per-row inline-edit toggle in this
  table needs BOTH halves: sibling-not-child placement (protects existing
  exact-textContent tests) AND conditional-render-only-when-open (protects
  the row-height ceiling).
- **A draft input for a TOGGLED (open/close) edit control does NOT need the
  "skip-first-mount + reset `useEffect`" guard** that `supplierDraft`/
  `commentDraft` (issue 63/64, both ALWAYS-visible inputs) need. Issue 121's
  `linkDraft`: since the input only exists while `linkEditing` is true, the
  draft is simply re-seeded FRESH from `line.supplierUrl` at the moment the
  toggle OPENS (`onClick`), never synced continuously via an effect — there
  is no mount-time race to guard against, because there is no persistent
  mounted input to race with. Simpler AND correct. Only reach for the
  effect-based reset pattern when the input is ALWAYS mounted and its
  source prop can change while the user might be mid-edit.
- **Measure real column budgets with a throwaway Playwright script against
  the LOCAL dev servers, never hand-derive px-per-character or eyeball a
  screenshot, before tuning `min-width`/`colgroup` percentages.** Issue 105:
  `pnpm --filter @forestshop/web dev` + `pnpm --filter @forestshop/api start`
  (env `DATABASE_URL`/`SESSION_COOKIE_SECURE=false`, `.claude/rules/
  local-dev.md`'s local DB) + a one-off Node script requiring the workspace's
  own `apps/web/node_modules/@playwright/test` (`createRequire` from an
  `.mjs` file) logging in as the seeded e2e user and reading real
  `getBoundingClientRect()`/`scrollWidth`/`clientWidth` values at each target
  viewport gave EXACT numbers (e.g. "98.33px available after the save
  button's real 53px width") that a first `min-width` guess (3.5rem) missed
  by enough to still wrap — the second, measured attempt (2rem/3rem) worked
  first try. This is free (no deploy needed) and catches exactly the
  flex-basis trap above, which pure CSS reasoning does not surface until you
  see it render.
- **A `<colgroup>` percentage budget MUST be verified against REAL PRODUCTION
  content shape, not just the e2e fixture — the fixture's short, simple test
  data can hide a regression that only shows up on real rows.** Issue 107
  bodies 1+2 needed `col-state`/`col-notes` to grow a lot (9%→14%, 12%→24%),
  funded partly by shrinking `col-supplier` (14%→8-11%). That passed the FULL
  e2e suite and looked fine against the seeded fixture (`orders.spec.ts`'s
  `4859/46` row, plain "Odkaz na dodávateľa" link, no `externalCode`) — but
  after deploying, live measurement against `forestshop-novy.newlevel.media`
  (`vychod@varos.sk`) showed 92% of the 39 real rows carry that same link
  text PLUS a second "kód XXXX" line under it (`OrderLineRow.tsx`'s
  `.ord-supplier-code`, driven by `externalCode` — present on real supplier
  data, absent from the lean fixture), which wrapped across noticeably more
  lines once the column narrowed (`maxHeight` 85px→212px, 17/39 rows over
  100px — the opposite of the ticket's own "efektívna práca" goal). Fixed by
  re-verifying candidate `<colgroup>` percentages LIVE against production
  BEFORE settling on the final numbers, using `page.addStyleTag({content:
  ".col-x{width:Y%!important}"})` against the ALREADY-DEPLOYED page — this
  swaps column percentages in the live DOM instantly, no redeploy needed per
  candidate, so a wrong split (`col-product` at 12% made things worse, not
  better — `maxHeight` 173px vs 13%'s 134px) can be caught and corrected in
  seconds. **Two things to get right when doing this:** (1) test a COMPLETE
  set of column percentages that sums to exactly 100 each time — overriding
  just ONE column via `addStyleTag` while the others stay at their deployed
  values does NOT sum to 100 and produces misleading cross-column overflow
  (a `.col-product` override alone made `Zákazník`'s header "overflow", which
  had nothing to do with product); (2) log into the REAL account
  (`vychod@varos.sk`, see the `forestshop-app-login` memory note) to see the
  REAL 39-row dataset, not an isolated e2e account — the e2e fixture's
  fixtures are deliberately minimal and will never reproduce a real
  content-shape regression like this one. Any FUTURE `<colgroup>` percentage
  change needs this same live-against-production check before being called
  done, not just a green e2e suite.
- **`getClientRects().length` on a `<td>`/block element is ALWAYS 1, regardless
  of how many lines its text wraps onto** — that method reports per-line rects
  only for an INLINE formatting context (a `<a>`, a `<span>`, or a `Range`
  over a text node), never for the block box itself. Issue 111's first wrap-
  detection attempt checked `.ord-code-cell.getClientRects().length > 1` and
  got `0` even though the text was visibly wrapping 2-3 lines — the fix was
  `document.createRange().selectNodeContents(textNode); range.getClientRects
  ().length`, targeting the TEXT NODE inside the cell, not the cell itself.
  `.ord-admin-link` (an `<a>`, inline) worked fine directly. Any FUTURE "did
  this wrap" check against a `<td>`/`<div>`/block container needs the Range-
  over-text-node form, not a direct call on the container.
- **A "never wraps" requirement needs BOTH a generous measured width AND a
  permanent `white-space: nowrap` (+`overflow:hidden;text-overflow:ellipsis`
  fallback) on the element itself** — issue 111 (order # + product code
  breaking mid-number, the third time a `<colgroup>` budget alone was tried
  and regressed, after #105/#107) fixed it both ways: `.col-order`/`.col-code`
  got real measured budget AND `.ord-admin-link`/`.ord-code-cell` got
  `white-space: nowrap`. The CSS rule is what makes the guarantee survive a
  FUTURE longer order number or code format without another live-measurement
  cycle — width alone is only correct until content grows past today's
  sample.
- **When a `<colgroup>` budget can't fit inside the viewport's real available
  width, look at the SCREEN'S OWN padding/min-width first, not just the
  column percentages.** Issue 111 bod 5: `.orders-table`'s `min-width: 64rem`
  (1024px) was wider than the ACTUAL content area at 1280px (sidebar 250px +
  `.main-wide`'s own 2×32px padding = only 966px available) — the table was
  always horizontally scrolling inside `.orders-table-wrap`, hiding the 💾
  save button past the visible edge. Shrinking 10 columns to fit 966px alone
  would have starved every column that matters (measured: avg +20px/row
  height regression across 34/39 rows). The actual fix reclaimed a few px of
  `.main-wide`'s OWN horizontal padding (`--fs-space-6` → `--fs-space-1`,
  scoped to this dense work screen only, not global) AND lowered
  `.orders-table`'s `min-width` to match — turning an infeasible 966px budget
  into a workable ~1022px one. Any FUTURE "table doesn't fit at width X" bug:
  check `main.clientWidth` vs `.orders-table`'s `min-width` BEFORE assuming
  the fix is purely a `<colgroup>` percentage problem.
- **Comparing row-height min/median/max ACROSS candidate `<colgroup>`
  percentages is misleading — the row that LANDS at the median/min RANK
  changes per candidate**, since other columns' widths shift which rows are
  short/tall. Issue 111: a candidate showing "median 119px" looked like a
  disaster next to baseline's "median 85.5px" — but per-row PAIRED
  comparison (`Map` keyed by `data-testid`, same 39 rows, old height vs new
  height) showed the true picture: avg +11px, only specific rows changed
  meaningfully. Always diff the SAME rows before-vs-after (keyed by
  `data-testid`), never just compare the sorted-height array's summary
  stats between two differently-configured runs.
- **Removing a `<colgroup>` COLUMN entirely (not just resizing it) needs a
  grep across ALL e2e spec files for its CSS class, not just the spec file
  you're already editing** — this table's e2e coverage is split across
  `orders.spec.ts` (functional flows) and `orders-layout.spec.ts` (column-
  width/wrap regressions, issue 107), and a class-specific check can live in
  either one independently of which file you're touching. Issue 117 removed
  `.ord-code-cell` (the whole KÓD column) — `orders.spec.ts` had several
  `variantCode`-in-visible-text assertions (`toContainText("4859/46")`, a
  bare `toContainText("46")` fragment, `toContainText("60035/L")`, …) that
  silently kept passing in a first local run because they happened to sit
  in tests unrelated to the removed cell, but `orders-layout.spec.ts` had an
  ENTIRE dedicated check (`zalomeneKody`, issue 111's wrap-detection) built
  directly on `document.querySelectorAll(".ord-code-cell")` that CI caught
  failing on the first push (the local pre-push run only covered
  `orders.spec.ts` + `orders-layout.spec.ts` together, but a leftover
  fragment assertion — `toContainText("46")` — still slipped through both
  local AND the first CI run, since it read as part of an unrelated
  assertion chain; only the SECOND CI run, after fixing the first failure,
  surfaced it). Any FUTURE full-column removal: `grep -rn
  "<the-cells-class>" apps/web/tests/e2e/` across the WHOLE e2e directory
  before considering the removal test-safe, not just the spec file with the
  obviously-related test names.
- **When a `<colgroup>` column needs MORE width, test EVERY candidate donor
  column live against production BEFORE picking one — not just the column
  you'd guess has slack.** Issue 127 (stale-order badge, `.col-date`,
  overflowing its cell): live-testing (`page.addStyleTag`, 37 real rows,
  same methodology as issue 107/111) ruled out `col-notes` (only ~0.5
  percentage-point slack above the tested `≥160px` comment-input floor),
  `col-supplier` (regressed 3 REAL `supplierAssignable` rows over 120px —
  the existing code comment "žiadny živý riadok ho dnes nemá" was STALE;
  production had grown 3 such rows since it was written), `col-customer`
  (customer names already wrap almost universally, zero slack),
  `col-qty`/`col-state`/`col-order` (zero or negative slack, measured
  directly). Only `col-product` had genuine verified slack — a candidate
  that "should" have slack per an old design comment can be WRONG by the
  time you need it; test the actual live donor, never assume last-known
  slack is still there. Any FUTURE column-width increase: test the intended
  donor's real current content (not just the % on paper) against
  production first, and be ready to look at 2-3 candidates if the first
  one's own established comment turns out stale.
- **A JS-level in-memory rate limiter (`checkLoginRateLimit`,
  `login-rate-limit.ts`) resets INSTANTLY on API process restart, but a
  live-verification session hitting it against PRODUCTION has no such
  reset available — you just wait out the 5-minute window.** Repeated
  Playwright logins during local column-width measurement (issue 127) hit
  `MAX_ATTEMPTS=10` against the LOCAL dev API within a few scripts;
  restarting `pnpm --filter @forestshop/api start` cleared it immediately
  (module-level singleton, no DB state). The SAME limiter applies to the
  live production site — hit it there too during repeated
  `vychod@varos.sk` live-verification logins, and had to wait for the
  window to clear (no restart available on a shared prod process). Batch
  live-verification page interactions into ONE login per script/session
  (reuse the same `page`, just `setViewportSize` between checks) instead
  of a fresh login per viewport/candidate, to avoid burning through the
  10-attempt budget on read-only verification work.
- **A React wrapper/harness component that owns state AND is re-rendered
  BY that state must memoize (`useCallback`) any inline prop function it
  passes down, or a downstream `useCallback`-memoized effect will refire
  on every wrapper re-render.** Issue 147's `OrdersRemainingCountContext`
  test harness (`OrdersSection.remainingCount.test.tsx`) initially passed
  `onSessionExpired={() => {}}` as a fresh arrow literal on every render —
  since the harness itself re-renders every time `OrdersSection` calls
  `setCount` (the exact thing being tested), this broke `OrdersSection
  .tsx`'s own `useCallback(load, [onSessionExpired])` memoization and
  caused `fetchOpenOrders` to fire 3× instead of once, ONLY when wrapped
  in this test's specific harness (not reproducible by rendering
  `OrdersSection` directly, which is why every other existing test never
  hit it). Fix: `const onSessionExpired = useCallback(() => {}, [])` (and
  `useMemo` the Context Provider's `value` object) in the harness itself.
  Any FUTURE test harness/wrapper that re-renders in response to the
  thing under test needs the same treatment for every prop it passes down.
- **A value that must SURVIVE a tab switching away (unmounting the owning
  component) needs a React Context Provider living ABOVE the nav-switch
  point (`App.tsx`), not state lifted only as far as the tab's own
  parent.** Issue 147's nav badge: `OrdersSection` (the data owner) is
  unmounted the instant the user picks a different tab (`App.tsx` renders
  only `ActiveComponent`) — a naive "lift state to `App.tsx` via a
  callback prop" would still need `App.tsx` itself to special-case which
  tab gets the callback, breaking `nav.ts`'s "no `App.tsx` change to
  add/move a tab" invariant. The Context (`ordersRemainingCountContext.ts`)
  decouples "who PUBLISHES" from "who CONSUMES" — `OrdersSection` publishes
  whenever mounted, `Sidebar` consumes via a generic `badgeCounts` prop
  keyed by `tab.id`, and the value persists at its LAST KNOWN state once
  `OrdersSection` unmounts. Any FUTURE cross-tab-surviving value (a
  pending-count badge, a sync-status dot) should reach for this same
  shape rather than threading a new prop through `App.tsx`.
- **A filter/hide rule that can unmount a component mid-edit needs the
  "has open edit" signal lifted as a LIGHTWEIGHT boolean per item, never
  the draft text itself.** Issue 149: the naive fix would be lifting the
  full draft state (`supplierDraft`/`linkDraft`/`commentDraft`) out of
  `OrderLineRow` into `OrdersSection` so the filter could inspect it —
  rejected because it would break every existing "controlled draft +
  skip-first-mount + dirty guard" pattern already established per editor
  (this file's own earlier entries) for no benefit. Instead
  `useDirtyEditorLineIds.ts` carries ONLY `Set<lineId>` (open/not), and
  `OrderLineRow` reports it via a `useEffect([...deps])` whose cleanup ALSO
  reports `false` (handles both "closed" and "genuinely unmounted for an
  unrelated reason" in one code path). The single shared predicate
  (`ordersSummary.ts`'s `isLineHiddenByFilter`) is then the ONE place both
  the render-filter (`SupplierOrderGroup.tsx`) and the count
  (`OrdersSection.tsx`) apply the exception — never duplicate the
  three-way boolean logic (`hideResolved && resolved && !dirty`) inline in
  two files, they will drift.
- **A prop-syncing reset pattern (controlled draft + reset `useEffect` +
  "skip first mount"/dirty guard, the established shape for
  `supplierDraft`/`commentDraft`, issue 63/64) is the WRONG fix whenever the
  prop change ALSO implies the row moves to a DIFFERENT keyed React parent
  — that is a REMOUNT, not a re-render, and no local `useState`/`useEffect`/
  `ref` survives it.** Issue 151: manual supplier assignment is per-PRODUCT
  (`productSupplierOverrides` keyed by `productKey`), so any change to
  `line.manualSupplierOverride` ALSO changes `effectiveSupplier` — which is
  the `SupplierOrderGroup`'s own React key (`OrdersSection.tsx`'s
  `key={group.supplier}`). A row whose product just got (re)assigned is
  moved to a NEW `SupplierOrderGroup` subtree — empirically confirmed
  (`document.contains()` on the pre-refetch input returned `false`; a fresh
  `queryByLabelText` found a brand-new node already showing the server
  value). The fix: lift the value one level up, into the ancestor that does
  NOT remount (`OrdersSection`, `useSupplierDrafts.ts` — same principle as
  `useDirtyEditorLineIds.ts`/issue 149, but carrying the actual TEXT instead
  of a boolean). `OrderLineRow` then DERIVES its displayed value from props
  (`pendingDraft ?? line.manualSupplierOverride ?? ""`) instead of owning
  local state — no `useState`, no reset `useEffect`, no dirty ref needed at
  all, because a derived value is correct on BOTH a re-render AND a fresh
  mount. Before reaching for the `isCommentDirty`-style guard on a NEW
  prop-syncing effect, check whether the prop's OWN change can also move
  the row to a different keyed parent (a group/section/tab reassignment) —
  if yes, the guard cannot help; lift the state instead.
- **A regression test asserting "value survived a refetch" MUST re-query
  the DOM fresh after the refetch — reusing the pre-refetch element handle
  gives a FALSE GREEN even against genuinely broken code.** Issue 151's
  first draft of the RED test held onto the `HTMLInputElement` returned by
  `screen.findByLabelText` BEFORE the refetch and asserted its `.value`
  AFTER — it passed against the UNFIXED code, because the row had actually
  been REMOUNTED (see the entry above) and the stale/detached reference
  just kept echoing whatever `.value` it had at detach time, never the
  live DOM. Caught only because RED was run against unfixed code FIRST and
  it still passed (the whole reason the RED step exists) — the fix was to
  re-run `screen.getByLabelText(...)` (or an equivalent fresh query) AFTER
  the refetch, inside the final assertion, and add `document.contains()`
  as a debug check when in doubt whether a handle survived. Any FUTURE
  "does X survive a re-render/refetch/remount" test in this codebase:
  re-query fresh at assertion time, never trust an element handle captured
  before the change under test.
- **`display:flex` set DIRECTLY on a `<td>` breaks its participation in
  normal table-cell height matching** — issue 163 (deliaca čiara nelícuje
  pod bunkou s odkazom na dodávateľa): `td.ord-supplier-merged` had
  `display:flex; flex-direction:column; gap` for years (issue 95) with no
  visible problem, until a taller SIBLING cell in the same row (long
  product name/notes) made the row genuinely tall — the flex `<td>` sized
  to its OWN (shorter) content instead of stretching to the row's real
  height like every other (`display: table-cell`) sibling, so its
  `border-bottom` sat up to ~44px above the row's actual bottom edge (live
  measured: `td.getBoundingClientRect().height` 53px vs
  `tr.getBoundingClientRect().height` 91.5px). This is invisible in a
  short/uniform-height fixture and only shows up once ANY sibling cell in
  the row is genuinely taller — exactly why it went unnoticed for 68
  issues. Fix: never put `display:flex` straight on a `<td>` that needs to
  match the row's height; wrap its children in an inner `<div>` and put
  the flex styling there instead (or, if the only purpose was a gap
  between two always-stacked block children, replace it with `margin-top`
  on the second child — no wrapper element needed at all, as done here).
  Regression test for this class of bug: assert `td.getBoundingClientRect
  ().bottom` equals `tr.getBoundingClientRect().bottom` (±1px) for every
  row, not just "does it look OK in one screenshot" — a short/uniform e2e
  fixture will pass a screenshot check while still carrying the bug.
- **CSS Grid items default to `min-width: auto`, which respects the
  intrinsic (unwrapped) width of a single unbreakable WORD — the flex
  `flex-basis`-vs-`min-width` trap issue 105 documented above has a Grid
  analog, and it bit in the exact same "looks fine in the CSS, breaks only
  when actually rendered" way.** Issue 161's 2×2 state-button grid
  (`.ord-state-btn-group { display:grid; grid-template-columns: 1fr 1fr }`)
  visually overflowed into the NEXT column at 1280px — found ONLY by a
  live Playwright screenshot + `getBoundingClientRect()` diff against a
  local dev build (not by reading the CSS, not by the unit tests, which
  don't render real widths): the group's `scrollWidth` (161px) exceeded
  its rendered `width` (114px) because Slovak labels ("Nevybavené",
  "Nedostupné") are single words with no natural break point, and a grid
  item won't shrink below that intrinsic minimum unless told to. Fix:
  `min-width: 0` on the grid item + `overflow-wrap: break-word` (letting
  the label actually wrap inside the button instead of forcing the grid
  wider); `hyphens: auto` (with `lang="sk"` on `<html>`, already set) is a
  cheap improvement but not load-bearing — Chromium's Slovak hyphenation
  dictionary support didn't visibly change the render in this repo's test
  environment, only `min-width:0` + `overflow-wrap` actually fixed the
  overflow. Any FUTURE `display:grid`/`display:flex` layout in this app
  holding short, single-word (especially Slovak) labels in a narrow
  column needs a REAL rendered-width check (Playwright against a local
  dev server, not just CSS review) before shipping — this exact overflow
  is invisible in vitest/jsdom (no real layout) and easy to miss by eye on
  a wide monitor where the neighboring column happens to have slack.
- **Moving DOM content out of an existing `<tr>` into a NEW conditional
  sibling `<tr>` (an "expand row" pattern) breaks any e2e/unit test that
  scoped its query to the ORIGINAL row (`within(riadok)`,
  `riadok.getByLabel(...)`), even though the moved content's own testid
  never changed.** Issue 162 (supplier-link edit input too narrow — moved
  from inside `td.ord-supplier-merged` into `<tr colSpan={9}>` rendered as
  a sibling of the main `order-line-<lineId>` row, only while editing):
  fix in TWO places per affected test file — (1) vitest/testing-library:
  replace `within(riadok).getByTestId(...)` with plain `screen
  .getByTestId(...)` (safe when the test renders exactly ONE line, unsafe
  otherwise — check test fixture size first); (2) Playwright e2e: define
  `const editRiadok = riadok.locator("xpath=./following-sibling::tr[1]")`
  and query THAT instead of `riadok` for anything living in the moved
  content. The xpath locator is lazy (Playwright locators resolve at
  assertion time, not at `.locator()` call time), so defining it BEFORE
  the row is even open (before the sibling exists in the DOM) is safe —
  it only needs to resolve correctly at the point you actually use it.
- **A NEW row/element's testid must NOT share a `^='...'`-style PREFIX
  already used elsewhere to find a DIFFERENT element, even if the new
  element is semantically related.** Issue 162's first attempt named the
  new expand-row `order-line-<lineId>-link-edit` (seemed natural — it's
  "the edit row FOR that order line") — but several existing e2e tests use
  `[data-testid^='order-line-']` to find the MAIN row, and that prefix
  selector matched the NEW row too the instant it rendered, causing a
  Playwright strict-mode violation ("resolved to 2 elements") the moment
  any test opened the editor. Fix: renamed to `link-edit-row-<lineId>`
  (no shared prefix). Before naming a new sibling/child element with a
  testid that semantically extends an existing one, `grep -rn
  "data-testid\^='<prefix>'"` (or the exact base string) across
  `apps/web/tests/e2e/` to check whether a prefix-match query already
  exists that the new element would also satisfy.
- **A vitest unit test that needs a specific DOM element subtype from
  `screen.getByTestId(...)` should pass the type as a GENERIC ARGUMENT
  (`screen.getByTestId<HTMLInputElement>(...)`), never an `as
  HTMLInputElement` cast on the result** — issue 166's RED test wrote
  `const x = screen.getByTestId(...) as HTMLInputElement;` and eslint
  flagged it `@typescript-eslint/no-unnecessary-type-assertion`
  ("unnecessary since it does not change the type of the expression"),
  even though a DELIBERATE type-mismatch probe (`const x: number =
  screen.getByTestId(...)`) proved `tsc` itself infers the return as
  plain `HTMLElement` (no `.value`) without the cast — i.e. the assertion
  demonstrably DOES narrow the type, yet the rule still fires. Root cause
  not fully chased down (a typescript-eslint/testing-library-types
  generic-inference quirk, not a real "assertion does nothing" case) — the
  reliable fix either way is the generic-argument form, which resolves
  clean under both `tsc -b` and eslint. Any FUTURE
  `getByTestId`/`getByLabelText`/etc. result that needs a narrower element
  type in THIS codebase: use the generic argument, not `as`.
- **UN-merging one sibling OUT of an existing merged `<td>` (the inverse of
  the "merge two columns" pattern above) uses the SAME technique in
  reverse: move the existing testid'd `<div>` verbatim (no change to its
  `data-testid`/conditional-render logic) into its new parent `<td>` as a
  plain block-level sibling — never wrap the OLD OR NEW parent `<td>` in
  `display:flex` (issue 163's lesson stays true in both directions).**
  Issue 171 pulled `.ord-remark-cell` (customer note) out of
  `td.ord-notes-merged` into the product-name `<td>`, which meant that
  `<td>` needed its own text wrapped in a new `.ord-product-name` div
  first (a bare `{line.variantName}` text node can't be a "sibling" of
  anything) — any future un-merge into a `<td>` that currently holds only
  bare text needs that same one-time wrap.
- **A `<colgroup>`/row-height ceiling based on a `page.addStyleTag`
  candidate measurement (issue 105/107/111/127's methodology, run against
  a THROWAWAY Node script) can also be re-measured MUCH more cheaply by
  temporarily instrumenting the EXISTING e2e spec with a `console.log` of
  the real heights, running it once via `playwright test`, reading the
  logged numbers from stdout, then reverting the instrumentation before
  committing.** Issue 171 needed to know whether moving `remark` OUT of
  the row's tallest cell lowered the measured max height enough to justify
  tightening `orders-layout.spec.ts`'s ceiling — no throwaway script or
  live-production access needed, since the existing spec already logs in
  and asserts against the same seeded fixture (9001) that drives the
  ceiling. Pattern: copy the spec file to scratch first (`cp` for an easy
  revert), replace the `.filter((h) => h > N)` line with an unfiltered
  `console.log(JSON.stringify(heights))`, run `playwright test <file>
  --reporter=line 2>&1 | grep DEBUG`, restore the original file from the
  scratch copy, then apply the real (measured, justified) ceiling change.
  Cheaper than the full live-production methodology when the existing e2e
  fixture already reproduces the row shape in question — reach for the
  live-production `addStyleTag` script only when the e2e fixture's content
  shape doesn't match real production data (as issue 107 found out the
  hard way).
- **Hiding a button's visible label (conditional render, `display:none`) also
  DELETES its accessible name — an icon-only control needs `aria-label` +
  `title` set explicitly, and any information carried by a sibling badge that
  you also hide must be folded into that label.** Issue 190 (zbalený bočný
  panel do 72px lišty): the tab buttons render `{!rail && <span
  className="tlabel">}`, so in rail mode the only remaining child is an
  `aria-hidden` emoji — without `aria-label` the button's accessible name
  would be empty and every existing `getByRole("button", { name: "Na
  objednanie" })` query (unit AND e2e) would stop matching. The status pill
  ("Beží"/"Zastavené") is hidden in rail mode too, so the label becomes
  `${tab.label} — ${status}` and the same string goes into `title` (the
  hover tooltip the ticket asked for). Any FUTURE icon-only/compact variant
  of an existing labelled control in this app needs both attributes set in
  the SAME change, plus a unit test asserting `getByRole("button", { name })`
  still resolves in the compact state.
- **Two independent collapse mechanisms on the same tree must be composed
  explicitly, or one silently swallows the other.** The sidebar already had
  per-FOLDER collapsing (`.nav-folder.collapsed .folder-body {display:none}`);
  issue 190 added whole-PANEL collapsing where folder headings are not
  rendered at all. A folder collapsed before the panel collapsed would have
  hidden its icons with no heading left to click — unreachable. Fix is one
  line in the component, not CSS: `const isCollapsed = !rail &&
  collapsed[folder.id] === true` (the folder state is kept, just not applied
  while railed, so it returns on expand). Covered by its own unit test.
- **A UI preference stored in `localStorage` needs `window.localStorage
  .clear()` in the test file's `afterEach`** — jsdom keeps it between tests
  in the same file, so one test toggling the preference silently changes the
  starting state of every test after it (`Sidebar.test.tsx`, issue 190). Both
  read and write go in `try/catch` with the safe default, since a browser
  with storage disabled throws and must never take the app down over a
  preference.
- **Dialóg, ktorý sa otvára AŽ po dobehnutí serverového volania, si spúšťací
  prvok musí zapamätať už pri KLIKNUTÍ — `document.activeElement` v momente
  jeho otvorenia je vtedy už `<body>`.** Spúšťacie tlačidlo je počas
  načítania `disabled` (busy stav) a prehliadač z neho fokus zhodí, takže
  `MailPreviewDialog` po zavretí vracal fokus na začiatok stránky a obsluha
  ovládajúca appku klávesnicou stratila miesto v zozname (issue 191, nájdené
  až pri živom overení na produkcii, nie testom). Vzor: volajúci si drží
  `useRef` naplnený v `onClick` a odovzdá ho ako `returnFocusRef`; dialóg
  obnoví `returnFocusRef?.current ?? previous` a overí `isConnected`.
- **Návrat fokusu po zavretí prekryvu sa dá overiť LEN e2e testom —
  jsdom nezhadzuje fokus z prvku, ktorý sa práve stal `disabled`.** Overené
  troma spôsobmi (`blur()`, presun fokusu na iný prvok v tom istom riadku —
  ten je vtedy tiež `disabled`, takže fokus neprevezme): unit test prešiel aj
  proti pokazenému kódu, čiže by bol tautológia (`test-strictness.md`). Také
  overenie patrí do `tests/e2e/*.spec.ts` (`await expect(locator)
  .toBeFocused()`) a v unit súbore ostane len komentár, PREČO tam test nie je.
- **Pilulka/odznak s `white-space: nowrap` vykreslený INLINE v úzkej bunke
  pretečie do susedného stĺpca — a `text-align: right` to ešte skryje pred
  okom, lebo obsah "vyzerá zarovnaný".** Issue 204 (majiteľ: "link dodavatel
  a spolu sa prekrivaju … 1 ksΣ spolu 1 ks 🔗"): `.qty-total-chip` mala 82px
  obsahu v 54px bunke, takže sedela presne nad ikonkou 🔗 vedľajšieho
  stĺpca (naživo namerané: `chip.right 845` vs `td.right 796`,
  `td.scrollWidth 103` vs `clientWidth 54`). Toto je TRETÍ tvar tej istej
  triedy chýb po `.ord-stale-badge` (issue 127) a `.ord-supplier-assign`
  (issue 63) — **každý nový neinteraktívny odznak/pilulka v tejto tabuľke
  dostáva rovnaké tri veci naraz:** vlastný riadok v stack `<div>`e (nikdy
  `display:flex` priamo na `<td>` — issue 163), `max-width: 100%` +
  `overflow:hidden; text-overflow:ellipsis` (garancia pre BUDÚCI dlhší
  obsah, nielen dnešný), a čo najkratší text s celým vysvetlením v `title`.
  Regresná kontrola patrí do `orders-layout.spec.ts` rovnakým vzorom ako
  `staleOdznaky` (`element.right <= td.right` + `td.scrollWidth <=
  clientWidth` na všetkých 4 šírkach).
- **Skrátenie textu v bunke je lacnejšie než presúvanie `<colgroup>`
  percent.** Pri issue 204 stačilo "Σ spolu N ks" → "Σ N ks" (potreba klesla
  na 41px, zmestí sa do dnešných 54px) a **výška riadkov sa nezmenila ani o
  pixel** (paired meranie na 40 reálnych riadkoch, priemer aj maximum 0px) —
  darcovský stĺpec (postup issue 107/111/127) by naopak zhoršil iný stĺpec.
  Než začneš hľadať darcu, over, či sa obsah nedá skrátiť.
- **`display: inline-flex` na malej pilulke/odznaku spraví z jej TEXTU flex
  položku, ktorá sa zmrští na NULOVÚ šírku obsahu — zostane viditeľné len
  odsadenie a `text-overflow: ellipsis` dorobí zvyšok.** Issue 214 (majiteľ:
  *"teraz vobec nie je citatelne to spolu produkty"*): `.qty-total-chip` mala
  naživo `clientWidth 16 px` pri `scrollWidth 49 px` — teda presne svoje
  odsadenie a nič viac — a to na KAŽDEJ šírke okna, aj 1920 px. Fix:
  `inline-block` + `width: max-content` (+ `max-width: 100%` a orezanie
  ponechané ako poistka pre budúci dlhší obsah). Toto je ŠTVRTÝ tvar tej istej
  triedy chýb po issue 63/127/204 — a jediný, ktorý sa NEDAL nájsť kontrolou
  „pretŕča prvok svoju bunku?", lebo **orezaný prvok svoju bunku nikdy
  nepretečie**. Regresná kontrola preto meria `element.scrollWidth >
  element.clientWidth` na SAMOTNOM prvku, nie len jeho polohu voči bunke
  (`orders-layout.spec.ts`, kontrola vedľa `staleOdznaky`).
- **V najužšom stĺpci tabuľky je odsadenie bunky väčšie než jej obsah — rátaj s
  ním PRED hľadaním darcu percent.** Issue 214: `.col-qty` má 4 %, čo je pri
  1280 px okna 41 px, z toho bežné `--fs-space-3` odsadenie zožralo 26 px a na
  obsah zostalo 15 px. Zúženie odsadenia LEN pre tento stĺpec vyriešilo problém
  bez siahnutia na akýkoľvek iný stĺpec — lacnejšie než presúvanie percent
  (rovnaká úvaha ako „skrátenie textu" pri issue 204).
- **Zmerané naživo (issue 214, 42 reálnych riadkov): stĺpec s odkazom dodávateľa
  ani stĺpec s číslom objednávky NEMAJÚ rezervu, hoci opticky vyzerajú prázdne.**
  `col-supplier` −1,2 p. b. zdvihlo najvyšší riadok pri 1280 px zo 119 px na
  162 px (potvrdzuje zistenie issue 127, ktoré medzitým mohlo zastarať);
  `col-order` −1,2 p. b. orezalo `.ord-admin-link` na VŠETKÝCH 42 riadkoch pri
  1280 px (`white-space: nowrap` + ellipsis, takže žiadna bunka nepretiekla a
  kontrola cez `td.scrollWidth` to nezachytila — treba merať orezanie na
  samotnom odkaze). Pri ďalšom hľadaní darcu preto meraj OREZANIE obsahu darcu,
  nielen výšku riadkov.
- **Ref, ktorý má vždy niesť AKTUÁLNU hodnotu pre kód volaný z mikrotasky
  (`.then()` callback), sa musí syncovať SYNCHRÓNNE v tele komponentu (počas
  renderu), NIE cez `useEffect`.** Issue 251 (`SupplierLinksSection.tsx`'s
  `queryRef`/`stateRef`, čítané `refetch()`'om volaným zo `save()`'s
  `.then()`): `useEffect` beží AŽ PO commite ako pasívny efekt na
  samostatnom priechode (React ho môže odložiť za `paint`) — medzi commitom
  nového `query`/`state` a skutočným prebehnutím efektu existuje reálne
  okno, počas ktorého ref ešte nesie STARÚ hodnotu. Keďže `.then()` je
  mikrotaska, môže sa spustiť presne v tomto okne a prečítať zastaraný ref —
  teda ten istý race, aký mal "latest ref" vzor (issue 151, `.claude/rules/
  frontend-design.md`'s "derived value instead of stale local state")
  odstrániť, len preložený o jednu vrstvu nižšie. Fix: priama synchrónna
  aktualizácia (`queryRef.current = query;` hneď v tele komponentu, žiadny
  `useEffect`, žiadne pole závislostí) — React zaručuje, že táto priradenie
  prebehne skôr, než čokoľvek iné (vrátane akejkoľvek čakajúcej mikrotasky)
  môže ref prečítať. **Test na KAŽDÝ ĎALŠÍ "latest ref" vzor v tomto
  kódovej báze, kde ref číta kód spúšťaný z promise `.then()`/mikrotasky:**
  je sync v `useEffect`e, alebo priamo v tele komponentu? `useEffect` je
  správny LEN keď nič mikrotaskového ref nečíta pred ďalším renderom;
  sibling výskyty rovnakého (pred-opravou) tvaru nájdené a zapísané ako
  issue 254 (`PairingSection.tsx`'s `refetch`, `CatalogPage.tsx`'s
  `runIngest`) — over ich pri práci na tomto ticket-e.
- **Rovnaké "iba VLASTNÝ riadok" nedopatrenie sa dá skryť aj v busy-guarde,
  nielen v ref-synchronizácii vyššie — `busyKey`/`disabled` musí zvážiť
  vzťah k CUDZÍM riadkom, nie len k sebe.** Code review na issue 251's PR
  (`SupplierLinksSection.tsx`): `busyKey` disabluje LEN tlačidlá riadku,
  ktorého zápis prebieha — Upraviť/Doplniť na VŠETKÝCH ostatných riadkoch
  ostáva aktívne. Keď užívateľ otvoril INÝ riadok, kým prvý ešte čakal na
  PATCH odpoveď, jej `.then()`'s nepodmienené `setEditingKey(null)` ticho
  zavrelo ten cudzí, práve otvorený editor. Fix — rovnaký "latest ref"
  princíp ako záznam vyššie, len na `editingKey`: `editingKeyRef` sync
  priamo v tele komponentu, `.then()` zavrie editor LEN ak
  `editingKeyRef.current === productKey` (t.j. stále patrí TOMUTO zápisu).
  Regresný dôkaz musí byť SIEŤOVO deterministický (`page.waitForResponse()`
  na presnú POST URL), nie textová asercia stavu riadku — v zdieľanom e2e
  súbore môže PREDCHÁDZAJÚCI test v tom istom súbore ten istý stavový text
  ("čaká na odoslanie") už nastaviť skôr, takže by test prešiel aj keby sa
  spoľahol na cudziu, staršiu mutáciu namiesto vlastnej akcie.
- **`mountedRef`/unmount-guard vzor (`if (!mountedRef.current) return;` v
  `.then()`/`.catch()`) POTREBUJE nastaviť `true` AJ v samotnom
  `useEffect`'s TELE, nielen v `useRef(true)`'s počiatočnej hodnote.**
  Issue 251 (finding 3, `search()`'s guard): appka beží pod `<StrictMode>`
  (`main.tsx`) a vo VÝVOJOVOM móde (teda aj v `pnpm --filter @forestshop/web
  e2e`, ktorá ide cez `vite dev`) React zámerne efekt spustí, zruší a znova
  spustí — bez `mountedRef.current = true;` priamo v `useEffect`'s tele by
  toto PRVÉ simulované zrušenie navždy nechalo ref na `false` a appka by
  nikdy nezapísala žiadny výsledok vyhľadávania (živo namerané:
  `expect(riadok).toBeVisible()` padalo s "element(s) not found" na úplne
  PRVOM teste súboru). Vzor pre tento guard: `useEffect(() => {
  mountedRef.current = true; return () => { mountedRef.current = false; };
  }, [])` — nikdy len holý cleanup bez zodpovedajúceho "nastav true" v tele.

- **Riadkové farebné odlíšenie v tabuľke "Na objednanie" prešlo z
  3-stavového (`state-caka_sa`/`state-skladom`/`state-nedostupne`) na
  BINÁRNE podľa kanonického `isLineResolved` (issue 259) — každý ĎALŠÍ
  "farbi riadok podľa X" nápad na tejto tabuľke sa má najprv opýtať, či X
  je skutočne to, čo majiteľ chce vidieť, alebo len jeho PROXY.** Pôvodné
  3-stavové farbenie nechávalo VÄČŠINU riadkov (predvolený stav
  "objednane", ešte neobjednané) úplne biele — presne tie, čo "treba
  vybaviť" — a majiteľ to opísal ako "dnes sa nefarbí nič", hoci appka
  TECHNICKY farbila 3 z 5 stavov. Nová trieda `.line-resolved`/
  `.line-unresolved` (`app.css`) farbí podľa TOHO ISTÉHO predikátu, čo appka
  všade inde používa na "je tento riadok hotový" — nie podľa nového
  vlastného výpočtu. Farba NIKDY nie je jediný signál (existujúci stĺpec
  "Stav" + checkbox "Objednané" ostávajú) — colour-blind-safe bez extra
  UI prvku.
- **Meranie/zmenšovanie výšky nekontextuálneho bloku (dlaždice, panel,
  hlavička) naživo cez `page.addStyleTag` proti PRODUKCII je rovnako
  použiteľné na VÝŠKU ako na `<colgroup>` percentá (doteraz zdokumentované
  len pre tabuľkové stĺpce).** Issue 258 (dlaždice "Prehľad e-shopu"/"Súhrn
  o objednávaní" príliš veľké): namerané PRED zmenou (103px/79.5px na
  dlaždicu, blok 253.5px pri 1366×768), potom `page.addStyleTag` s
  kandidátskym CSS priamo na živej stránke, opäť namerané (58.5px/dlaždicu,
  169px blok, −33 %) — až PO potvrdení čísel sa kandidát preniesol do
  `app.css`. Rovnaký postup funguje pre AKÝKOĽVEK "toto zaberá príliš veľa
  miesta" ticket, nielen šírkové stĺpce.
- **Keď JEDNA položka v skupine (napr. "Všetci" súhrnný čip nad
  dodávateľskými čipmi) NEMÁ mať vlastný odvodený dátový stav, hoci
  vizuálne vyzerá ako člen tej istej skupiny** — daj jej VLASTNÝ
  modifikátor triedy (`chip-all` vedľa spoločného `chip`), ktorý v CSS
  resetuje späť na neutrál, namiesto toho, aby JS jednoducho prestal
  počítať jej stav. Issue 263 (majiteľ, doslovne "'Všetci' chip keeps its
  neutral/selected behaviour — it has no data state of its own"):
  `.chip` (základ) je teraz VÝRAZNÁ farba dátového stavu (zelená/červená
  cez `.done`), takže "Všetci" by ju dedil automaticky bez vlastného
  pravidla — `.chip.chip-all` prepíše späť na neutrálnu `--fs-surface-alt`,
  a `.chip.active` (deklarované AŽ PO `.chip-all` v súbore) stále víťazí pri
  výbere vďaka poradiu pravidiel pri rovnakej špecificite (dve triedy vs.
  dve triedy — vyhráva posledné v poradí zdroja).
- **"Aktívny výber prebíja odvodený dátový stav" (oranžová prebíja
  červenú/zelenú) sa dá zaručiť ČISTO poradím CSS pravidiel — deklaruj
  `.chip.active`/`.toorder-supplier.active` AKO POSLEDNÉ v súbore, po
  `.done`, keď obe majú rovnaký počet tried (rovnaká špecificita, posledné
  v zdroji vyhráva).** Toto NEPOTREBUJE `!important` ani vyššiu
  špecificitu — len vedomé poradie. Overuj to VŽDY živým
  `getComputedStyle` (Playwright), nikdy len prítomnosťou oboch tried v
  `className` — jednotkový test cez `className.toContain("active")` a
  `.toContain("done")` prejde aj vtedy, keď by CSS poradie bolo obrátené a
  vyhrávala by červená namiesto oranžovej (issue 263: `orders-layout
  .spec.ts` explicitne klikne na "vybavený" DODAVATEL-TEST-1 čip a
  porovná skutočnú `rgb(...)` farbu pozadia, nie len triedy).
- **Dve fixtúrové skupiny dodávateľa v `scripts/e2e-setup.ts` už DNES
  pokrývajú oba krajné dátové stavy bez akejkoľvek mutácie** — DODAVATEL-
  TEST-1 (`4859/46`, `state: "caka_sa"`) je odjakživa "vybavený"
  (`isLineResolved` = true), DODAVATEL-TEST-2 (`60055/10` ×2, predvolený
  `"objednane"`) je odjakživa "nespracovaný". Nový e2e test na farbenie
  podľa stavu (issue 263) toto využil priamo — žiadny nový izolovaný účet,
  žiadne riziko kolízie so súbežne bežiacimi spec súbormi z mutácie
  zdieľaných dát. Pri ĎALŠOM teste, čo potrebuje "skupinu v stave X",
  najprv skontroluj, či niektorá z existujúcich fixtúrových skupín (grep
  `state:`/`ordered:` okolo insertov objednávok v `scripts/e2e-setup.ts`)
  už ten stav nemá PRIRODZENE, než siahneš po mutácii cez UI.
- **Popup/dialóg s ASYNC Uložiť/Obnoviť A tlačidlom Zrušiť/Esc/klik-na-pozadie
  potrebuje `close()` ako NO-OP počas `busy`, inak vzniká race medzi
  "zavri a vráť live náhľad na baseline" a "požiadavka práve teraz úspešne
  doběhla".** Issue 264 (`ThemeColorPicker.tsx`, code review — nájdené DRUHÝM,
  hlbším prechodom, nie prvým): kliknutie na Zrušiť/Esc PO odoslaní Uložiť,
  ale PRED jeho odpoveďou, okamžite prepísalo živý CSS náhľad späť na
  hodnoty pri otvorení — a keď server medzitým úspešne uložil NOVÉ farby,
  jeho `.then()` si nastavil `baseline`, ale NIKDY znova nezavolal
  `applyThemeColors(draft)` (predpokladal, že náhľad je stále aktuálny).
  Appka tak ukazovala staré farby, hoci server aj `baseline` už mali nové,
  až do reloadu. Fix: `close()` skontroluje `busy` a nič nespraví, kým je
  `true`; tlačidlo Zrušiť dostane aj `disabled={busy}` (viditeľná spätná
  väzba, `close()`'ov guard je skutočná poistka, keďže Esc/backdrop-click
  tlačidlo obchádzajú). Rovnaký test na KAŽDÝ ĎALŠÍ popup v tejto appke s
  async zápisom + samostatným zrušením: môže užívateľ zavrieť/zrušiť PRESNE
  v okne medzi odoslaním a odpoveďou? Ak áno, `close()` potrebuje ten istý
  `busy`-guard, nie len zablokované tlačidlo Uložiť/Obnoviť.
- **Reopen toho istého popupu (druhé a ďalšie otvorenie) musí vynulovať
  predchádzajúci načítaný stav PRED novým fetchom, inak zlyhaný refetch
  necháva STARÝ draft/baseline vykresľovať sa ako čerstvý.** Issue 264:
  `openPicker()` teraz volá `setColors(null); setDraft({}); setBaseline({})`
  pred `fetchThemeColors()` — bez toho by neúspešný refetch (sieťový
  výpadok) ticho preskočil "Načítavam…" stav (keďže `colors !== null` z
  MINULÉHO otvorenia) a užívateľ by mohol uložiť zastaraný draft bez
  varovania. Rovnaký `fetchSeqRef`-štýl guard (inkrementovaný pri KAŽDOM
  otvorení, `.then()` sa uplatní len ak je stále najnovší) chráni pred
  opačným prípadom — STARŠIA odpoveď z PRED zavretého+znovu otvoreného
  popupu prepisujúca NOVŠÍ stav (rovnaká trieda race ako issue 151/251,
  pozri "latest ref" záznamy vyššie v tomto súbore).
- **"Uložiť je disabled pri neplatnom vstupe" NESTAČÍ ako celá odozva —
  majiteľ sa musí dozvedieť PREČO a KTORÉ pole je zlé, a to sa dá odvodiť
  priamo z existujúceho `draft`/validačného stavu bez nového `useState`.**
  Issue 264 (živé overenie 0.3.0-dev.153, hex kód farby): `ThemeColorPicker
  .tsx` už mal `allValid`/`dirty` ako ODVODENÉ hodnoty z `draft` — chýbajúca
  hláška sa doplnila rovnakým princípom (`invalidKeys = new Set(Object
  .entries(draft).filter(([,v]) => !HEX_RE.test(v)).map(([k]) => k))`
  priamo v render tele), nie ďalším `useState` synchronizovaným v
  `setValue()`. Spoločná hláška znovupoužila EXISTUJÚCI globálny
  `[role="alert"]` CSS blok (`app.css`) pod VLASTNÝM `data-testid` (odlišným
  od serverového `themecolor-error`u v tom istom komponente, aby oba mohli
  koexistovať). Per-pole označenie ide cez `aria-invalid` prop + CSS
  selektor `[aria-invalid="true"]` (existujúci `--fs-danger`/`--fs-danger-
  bg` token, žiadny nový raw hex). Test na KAŽDÉ ĎALŠIE "tlačidlo je len
  disabled" miesto v appke: dá sa dôvod odvodiť z toho, čo už komponent
  počíta? Ak áno, pridaj hlášku + `aria-invalid` ako odvodenú hodnotu, nie
  nový stav.
- **Tento projekt NEMÁ `eslint-plugin-react-hooks` nakonfigurovaný** — písanie
  `// eslint-disable-next-line react-hooks/exhaustive-deps` (bežný vzor v
  iných React projektoch) tu NEZTLMÍ nič, naopak SPADNE s "Definition for
  rule 'react-hooks/exhaustive-deps' was not found" (issue 267, nájdené
  `pnpm lint`om pred pushom). Dôsledok je vážnejší než len chybný komentár:
  **bez tohto pluginu ESLint nikdy neupozorní na neúplné dependency pole
  `useCallback`/`useEffect`**, takže stale-closure bug (funkcia zachytí
  STARÚ hodnotu premennej z prvého renderu, lebo chýba v `[]` poli) treba
  nájsť RUČNÝM code review, nie spoľahnutím sa na lint. Presne toto sa stalo
  v `UpozorneniaSection.tsx`'s `withBusy` — `useCallback((key, action) =>
  {...action().then(load)...}, [])` s PRÁZDNYM poľom navždy zamrazil `load`
  z PRVÉHO renderu, takže po prepnutí filtra "aj vybavené" (ktoré mení
  `load`'s identitu cez jeho vlastný `useCallback([includeResolved, ...])`)
  by `withBusy` po akcii refetchol so STARÝM filtrom. Fix: `load` patrí do
  `withBusy`'s dependency poľa (`[load]`), presne ako susedný `saveDraft`
  už mal správne. Test na KAŽDÝ ĎALŠÍ `useCallback`/`useEffect` v tomto
  repe: manuálne prejsť, či telo číta niečo, čo NIE JE v dependency poli —
  lint to tu NIKDY nezachytí.
- **Pridanie DRUHEJ nezávislej pod-obrazovky (záložka/tab) do existujúcej
  sekcie NESMIE zdediť pôvodnej loading/error "gate" tej PRVEJ pod-
  obrazovky na CELÝ návratový JSX.** Issue 283 (code review pred mergom,
  nie test): `UpozorneniaSection.tsx` mal pôvodne `if (rows === null)
  return <p>Načítavam…</p>;` PRED vykreslením čohokoľvek — keď pribudla
  nezávislá záložka "Vybavené" (vlastný fetch, vlastný komponent
  `UpozorneniaResolvedList`), táto stará gata (patriaca LEN "Otvorené"
  zoznamu) blokovala aj samotný PREPÍNAČ záložiek, takže obsluha sa
  nedostala k "Vybavené" kým "Otvorené" ešte len načítavalo (alebo
  sieťovo zlyhalo — v tom prípade NAVŽDY, kým nezobrazí len chybu bez
  akcie). Fix: `intro`/`tabBar` JSX sa počíta VŽDY (pred akýmkoľvek
  early-return), samostatná vetva `if (activeTab === "druhá-záložka")
  return (...)` sa vráti PRED gate patriacou prvej záložke, a gate samotná
  sa vzťahuje LEN na zvyšný "prvá záložka" flow. TypeScript-ova
  narrow-cez-ternár past: `activeTab === "X" ? A : B` NEVIE skombinovať
  narrowing so SAMOSTATNÝM skorším `if (cond && rows === null) return`
  (dva oddelené kontrolné toky) — preto to musí byť postupnosť
  PLOCHÝCH `if (...) return (...)` vetiev v JEDNOM rovnom toku, nie
  ternár za skorším podmieneným returnom. Regresný test (`UpozorneniaSection
  .resolvedTab.test.tsx`): mockni prvej záložky fetch tak, aby sa NIKDY
  nevyriešil (`new Promise(() => {})`) aj tak, aby zlyhal, a over v OBOCH
  prípadoch, že prepínač záložiek (`data-testid="...-tab-druhá"`) je
  napriek tomu v DOM-e. Test pre KAŽDÚ ĎALŠIU sekciu, čo dostane DRUHÚ
  nezávislú záložku: patrí existujúca loading/error gate LEN jednej
  záložke? Ak áno, presuň ju AŽ ZA vetvu tej druhej, nikdy ju nenechaj
  gatovať spoločný prepínač.
- **`DEFAULT_TAB_ID` (predvolená obrazovka PO PRIHLÁSENÍ, `nav.ts`) bolo
  odvodené od `NAV[0]?.tabs[0]?.id` — akékoľvek PREUSPORIADANIE priečinkov
  v `NAV` teda ticho zmení aj landing obrazovku, hoci o tom zadanie vôbec
  nehovorí.** Issue 287 (majiteľ chcel "Eshop" ako prvý priečinok — čisto
  vizuálne poradie v menu) by bez zásahu presunulo predvolenú obrazovku zo
  "Sync zo Shoptetu" na "Na objednanie" — nezadaná vedľajšia zmena správania
  ("scope creep" cez náhodnú väzbu v kóde, nie cez úmysel). Fix:
  `DEFAULT_TAB_ID` je teraz PEVNÝ literál `"sync"`, nezávislý od poradia v
  `NAV`. Pri KAŽDOM ĎALŠOM preusporiadaní `NAV` (pridanie/presun priečinka,
  zmena poradia skupín) skontroluj, či sa `DEFAULT_TAB_ID` nezmenil ticho —
  ak zadanie nežiada zmenu landing obrazovky, drž ju pevnú.
- **Zdieľaný obal na vodorovné rolovanie tabuľky (issue 291 — 19 obyčajných
  tabuliek dostalo VLASTNÝ posuvný obal namiesto rolovania celej stránky):
  nová trieda `.fs-table-wrap { overflow-x: auto; }` (`app.css`, hneď za
  generickým `table` resetom) je pre KAŽDÚ jednoduchú tabuľku, ktorá
  nepotrebuje vlastné rozloženie — `<table>` sa len obalí `<div
  className="fs-table-wrap">`, žiadna zmena vnútri tabuľky.
  `.orders-table-wrap`/`.ml-table-wrap` (existujúce PRED týmto tiketom)
  ostávajú SAMOSTATNÉ triedy — majú svoj vlastný `min-width`/
  `table-layout`, tie sa nezjednocovali. Test na KAŽDÚ ĎALŠIU novú
  `<table>` v appke: obal ju rovno `.fs-table-wrap`-om, nikdy nenechávaj
  tabuľku bez vlastného posuvného obalu (`.main > main` — bežná, nie
  `wide: true`, obrazovka — nemá `overflow-x: hidden`, takže neobalená
  tabuľka posunie celú STRÁNKU, presne akceptačný prípad tiketu — "Sync zo
  Shoptetu" mala 4085px `scrollWidth` pri 375px okne).
- **Sidebar (`Sidebar.tsx`, issue 190's rail mechanizmus) dostal PRVOTNÝ
  (mount-time) predvolený stav podľa šírky okna (issue 291) — uložená
  voľba v `localStorage` VŽDY vyhráva, šírka rozhoduje LEN keď žiadna
  voľba ešte neexistuje.** `readStoredRail(): boolean | null` (`null` =
  nič uložené, na rozdiel od pôvodného `readRail(): boolean`, ktoré
  chýbajúci kľúč nerozlíšilo od výslovného "rozbaliť") + `isNarrowViewport()`
  (`window.innerWidth <= 640`) → `initialRail()` = `stored ?? narrow`. Toto
  je ČISTO mount-time predvoľba, ŽIADNY `resize` listener — appka sa na
  zmenu šírky OKNA počas behu nereaguje (mimo dohodnutého minimálneho
  rozsahu tiketu). Existujúci `useEffect` (zápis do `localStorage` pri
  KAŽDEJ zmene `rail`) ostal nezmenený — aj auto-predvoľba sa teda hneď
  "zapíše" ako keby ju užívateľ zvolil; to je zámerné (rovnaké zariadenie
  nabudúce dostane rovnaký predvolený stav bez opätovného prepočtu
  šírky), nie chyba. Test pre `window.innerWidth` v jsdom: `Object
  .defineProperty(window, "innerWidth", {writable:true, configurable:true,
  value: N})` PRED `render()` — priama `window.innerWidth = N` v jsdom
  nesedí spoľahlivo na getter/setter, treba `defineProperty`; a treba ju
  po teste VRÁTIŤ (`afterEach`) presne z rovnakého dôvodu ako existujúci
  `localStorage.clear()` o pár riadkov vyššie v tom istom súbore.
- **`flex: 0 0 auto` na flex položke, ktorá sa MÔŽE ocitnúť SAMA na
  vlastnom zalomenom riadku (`flex-wrap: wrap` na rodičovi), zabráni jej
  zmenšiť sa aj keď na ten riadok nemá dosť miesta — položka potom
  jednoducho PRETRŠÍ mimo rodiča/viewport, nie je to vidno v CSS, len pri
  reálnom vykreslení na úzkej šírke.** Issue 291 (topbar sa mal zalomiť,
  aby meno prihláseného nezmizlo): `.topbar` dostalo `flex-wrap: wrap`, ale
  `.topbar-user` (koliesko "Farby aplikácie" + meno prihláseného) malo
  ZDEDENÉ `flex: 0 0 auto` (issue 264) — na 375px zalomilo na VLASTNÝ
  riadok správne, ale `flex-shrink: 0` mu bránilo zmenšiť sa POD svoju
  obsahovú šírku (298px) do dostupných 239px, takže blok ticho pretŕčal
  27px mimo viditeľnú šírku (`document.documentElement.scrollWidth` 402px
  namiesto 375px) — objavené AŽ živým Playwright meraním
  `getBoundingClientRect()` pri 375px, nie čítaním CSS (jsdom by to vôbec
  nezachytilo, žiadny reálny layout). Fix: `.topbar-user` → `flex: 0 1
  auto; min-width: 0;` (dovolí zmenšenie CELÉHO bloku) + `.usermenu-btn`
  (meno prihláseného, existujúce orezanie textu `overflow:hidden;
  text-overflow:ellipsis`) → `flex: 1 1 auto; min-width: 0;` (zmenšenie
  ide PRVOTNE na toto tlačidlo, nie na `.themecolor-btn`'s pevné 36px
  koliesko vedľa neho, ktoré si drží svoje PÔVODNÉ `flex: 0 0 auto`).
  Test na KAŽDÚ ĎALŠIU `flex-wrap: wrap` zmenu v appke: má NEJAKÁ položka,
  čo môže skončiť SAMA na zalomenom riadku, `flex-shrink: 0` (explicitne
  alebo cez `flex: 0 0 auto`)? Ak áno, over REÁLNYM Playwright meraním pri
  najužšej cieľovej šírke (nie len vizuálne na širokom monitore), či sa
  nezmenší namiesto zalomenia — over `element.getBoundingClientRect
  ().right <= window.innerWidth`, nie len že "vyzerá to zalomené".
- **Playwright's `Timed out waiting 60000ms from config.webServer` (žiadny
  ďalší výstup) je ZNÁMY jav na tomto zdieľanom, vyťaženom boxe (issues
  287/288, `.claude/rules/testing.md`) — potvrdené znova pri issue 291
  (`uptime` ukázal load average 33 tesne po behu integračných testov).**
  Žiadna zmena kódu, len počkanie na pokles záťaže (load average pod ~10)
  a čistý opakovaný beh — 46/47 prešlo hneď, jediné zvyšné zlyhanie
  (nesúvisiaci `upozornenia.spec.ts`) bol ĎALŠÍ prípad TEJ ISTEJ triedy
  (izolovaný re-beh prešiel čisto). Pred hľadaním regresie v diffe: over
  `uptime`/`ps aux | grep vitest` PRED panikou, over izolovaným re-behom
  PRESNE zlyhaného súboru.
- **"Zmenši medzery/objekty naprieč CELOU appkou" (issue 303, majiteľ:
  "vsetko zabera priatelia miesta ... uz mam okuliare, vidim celkom
  dobre") sa rieši VÝHRADNE zmenou `:root`'s `--fs-space-*`/`--fs-text-*`
  ČÍSEL v `app.css`, nikdy súbor-po-súbore — appka je od issue 57 postavená
  tak, že KAŽDÁ obrazovka/tabuľka/dialóg čerpá odsadenie/písmo z týchto
  tokenov, takže jedna centrálna zmena čísel sa prejaví VŠADE naraz.
  Zvolená škála (jeden krok hustejšie): `--fs-space-1` ostáva 4px
  (najmenšia atomická jednotka), `-2..-7` 8/12/16/24/32/48px →
  6/8/12/16/24/32px; `--fs-text-xs/-sm` (12/13px, tabuľky + drobné
  popisky — dnešná čitateľnosti podlaha) ostávajú NA MIESTE, `-base/-md/
  -lg/-xl` (15/17/21/26px → 14/15/18/22px) klesajú o jeden krok; `body`
  `line-height` 1.5 → 1.4. Klikacie plochy s VLASTNÝM pevným
  `min-width`/`min-height` (36×36px "veľké tlačidlá", `.rail-toggle`'s
  40px) NIE sú odvodené z tejto škály, takže sa nezmenšili — zámerne,
  zadanie žiada zachovať rýchlu prácu myšou. Keďže ide o čisto vizuálnu
  zmenu bez zmeny správania, nemá zmysel red/green pár — namiesto toho
  over, že VŠETKY existujúce testy (unit + integration + e2e) prejdú
  bezo zmeny (kontrolujú HORNÉ hranice výšky riadku / šírky stĺpca, nie
  presné pixely, takže zmenšenie ich neprelomí) a urob živé Playwright
  overenie proti lokálnemu dev serveru. Pri ĎALŠOM "appka je príliš X"
  tickete over NAJPRV, či sa dá vyriešiť len posunom týchto tokenov, než
  siahneš po úprave jednotlivej obrazovky.
- **`pnpm exec tsx scripts/e2e-setup.ts` spustený SÚBEŽNE s bežiacim
  `pnpm --filter @forestshop/api test:integration` na TEJ ISTEJ
  `DATABASE_URL` spôsobí SKUTOČNÉ, nesúvisiace zlyhanie integračného
  testu** — `e2e-setup.ts`'s vlastný `TRUNCATE` zoznam (`.claude/rules/
  testing.md`) nie je chránený `withCleanDb()`'s advisory zámkom, takže
  jeho TRUNCATE `sessions`/`users` môže padnúť presne do okna bežiaceho
  testu a zneplatniť jeho session (issue 303: `supplier-mail.integration
  .test.ts` dostalo 401 namiesto očakávaného 503 — vyzeralo to ako
  regresia, bol to len súbežný beh). Fix nie je v kóde: NIKDY nespúšťaj
  `e2e-setup.ts` (ani manuálne pre živé Playwright overenie), kým beží
  `test:integration` na tej istej DB — počkaj na jeho koniec
  (`ps aux | grep vitest`), až POTOM seeduj/over naživo. Pri
  podozrivom, na prvý pohľad nesúvisiacom zlyhaní integračného testu
  (najmä auth-kódy 401/403 tam, kde sa to nečaká) skontroluj najprv, či
  medzitým nebežal iný proces mutujúci zdieľané tabuľky, a over
  IZOLOVANÝM opakovaným behom, než hľadáš regresiu v diffe.
- **Issue 303 follow-up (majiteľ: "menšie objekty"): globálne
  `input:not([type="hidden"]) {width:100%}` (app.css §1) je PIATY tvar
  issue 105's flex-basis-z-width pasce — tentoraz cez `width: 100%`, nie
  fixný `width`.** `.upozornenie-actions` (`UpozornenieCard.tsx`, karta
  nástenky Upozornenia) má `display:flex` bez `flex` na svojich deťoch —
  dátumové pole "odložiť do" tak dostalo `flex-basis` z `width:100%`, teda
  CELÚ šírku riadku (naživo namerané: 1491px pri 1600px okne), a tri
  ovládacie prvky sa zalomili na tri riadky (104px vysoký pás, karta 269px
  namiesto ~150px pre rovnaký obsah). Fix: `.upozornenie-actions
  input[type="date"] { width:auto; min-width:9.5rem; flex:0 0 auto; }` —
  `width:auto` necháva prehliadačovu VLASTNÚ intrinzickú šírku dátumového
  poľa (namerané Chromium/sk-SK: 136px), `min-width` je len poistka pre
  širší formát iného jazyka/OS, `flex:0 0 auto` bráni ROVNAKÉMU riadku
  znova ho naťahovať. Overovacia technika (rovnaká ako issue 105/107/…):
  `page.addStyleTag` s kandidátnymi šírkami proti LOKÁLNEMU dev serveru
  (`.upozornenie-form label input[type=date]` je INÝ prípad — stĺpcový
  `<label>`, tam je `width:100%` správne, zámerné, netreba opravovať).
  KAŽDÝ ĎALŠÍ bare `<input>`/`<select>` priamo v `display:flex` riadku BEZ
  vlastnej width-obmedzujúcej CSS triedy (na rozdiel od zavedených
  `.ord-supplier-assign-input`/`.ord-comment-input`/`.tosup-emailinput`)
  zdedí rovnakú pascu z tohto globálneho resetu — grep `apps/web/src/
  styles/app.css` na existujúcu triedu PRED tým, než sa pridá nový bare
  `<input>` do flex riadku.
- **RED/GREEN overenie ČISTO-CSS opravy bez existujúceho testu: `git
  stash push --keep-index -- <css-súbor>` dočasne vráti CSS do
  PRED-opravového stavu (bez straty už napísaného, staged testu), beží sa
  proti live Vite HMR (žiadny rebuild potrebný), `git stash pop` opravu
  vráti späť.** Použité tu, lebo issue 303's fix bol objavený/zmeraný
  PRED napísaním regresného testu (živé meranie cez Playwright MCP proti
  `pnpm --filter @forestshop/web dev`) — namiesto prepisovania CSS ručne
  vzad a vpred stačí jeden `git stash` cyklus okolo `playwright test -g
  "<názov testu>"` na dôkaz RED, potom `stash pop` + rovnaký beh na dôkaz
  GREEN. Rýchlejšie než plný `pnpm --filter @forestshop/web e2e` cyklus
  pri overovaní JEDNÉHO testu.
- **Zdieľaný "Načítať ďalšie" stránkovací mechanizmus je `apps/web/src/
  useLoadMore.ts` (issue 337) — KAŽDÁ ĎALŠIA obrazovka, ktorá potrebuje
  prekročiť `page: 1`/pevný `pageSize`, ho má POUŽIŤ, nie znova
  vynachádzať vlastný page-tracking stav.** Zapojenie na 4 existujúcich
  obrazovkách (`CatalogPage.tsx`/`PairingSection.tsx`/
  `SupplierLinksSection.tsx`/`RestockLinkSuggestionsSection.tsx`) je
  identické: `useLoadMore({mountedRef, onAppend, onError})`, `reset()`
  volaný na ZAČIATKU `search()`, tlačidlo `data-testid="load-more"`
  viditeľné len keď `items.length < total`, klik pripojí (nikdy
  nenahrádza) výsledok.
- **`reset()` v `useLoadMore.ts` MUSÍ vyčistiť KAŽDÝ derivovaný stav, ktorý
  jeho vlastný generation-guard môže "zamraziť" — nestačí len zvýšiť
  generáciu.** Code review na PR 341 (issue 337): `reset()` pôvodne len
  bumpol `genRef`, no `loadingMore` sa nastavuje `true` pri štarte
  `loadMore()` a späť na `false` AŽ v jeho `.finally()`, ktoré je SAMO
  podmienené `gen === genRef.current` — takže reset VYVOLANÝ, kým staré
  "load more" volanie ešte čaká na odpoveď, spôsobil, že `.finally()` sa
  pre TÚTO (teraz zastaranú) požiadavku už nikdy neuplatnil a `loadingMore`
  ostal `true` navždy (tlačidlo trvalo "Načítavam…"/disabled). Bežný
  spúšťací sled: klik "Načítať ďalšie" → PRED doručením odpovede nové
  vyhľadávanie. Fix: `reset()` teraz aj `setLoadingMore(false)`. Test na
  KAŽDÝ ĎALŠÍ generation-guard v tomto repe (`searchSeq`/`gen`/podobne):
  existuje vedľajší `useState` boolean (busy/loading/disabled), ktorý sa
  nastavuje `true` PRED asynchrónnou operáciou a späť `false` AŽ vnútri
  toho istého guardovaného `.then()/.catch()/.finally()`? Ak áno, `reset()`
  (alebo čokoľvek, čo guard obchádza) ho musí vyčistiť SÁM, inak zostane
  navždy zaseknutý.
- **"Latest ref"/`queryRef`-`stateRef` trieda chyby (issue 251/254, viď
  vyššie v tomto súbore) sa netýka LEN `.then()` mikrotaskov — presne ten
  istý bug vzniká aj v ONCLICK handleri, ktorý priamo číta LIVE component
  state namiesto hodnôt, čo skutočne vyprodukovali zobrazené výsledky.**
  Code review na PR 341 (issue 337): "Načítať ďalšie" tlačidlo na všetkých
  4 obrazovkách pôvodne volalo `searchXxx({q: query, state, page})` —
  `query`/`state` sú kontrolované vstupy, menia sa pri KAŽDOM stlačení
  klávesy/zmene selectu, NEZÁVISLE od toho, či `search()` (submit) preň
  vôbec prebehol. Scenár: odošli vyhľadanie "socks" → výsledky sa
  vykreslia → rozpíš INÝ text bez kliknutia na "Hľadať" → klik na "Načítať
  ďalšie" ticho vyžiada druhú stranu NOVÉHO, NEODOSLANÉHO dopytu, hoci
  `items`/`total` na obrazovke ešte patria pôvodnému. Fix: `search(q, s)`
  (ktorá už dostáva presne odoslané hodnoty) ich synchrónne uloží do
  VLASTNÉHO refu (`searchedQueryRef`/`searchedStateRef`, oddeleného od
  existujúceho `queryRef`/`stateRef`, ktorý zámerne zrkadlí LIVE hodnotu
  pre INÝ účel — ingest/refetch race), tlačidlo číta z tohto refu, nikdy z
  live stavu vstupov. Test na KAŽDÝ ĎALŠÍ onClick/onSubmit handler v tomto
  repe, ktorý volá server s hodnotou z `useState`u kontrolovaného vstupu:
  je táto hodnota GARANTOVANE tá istá, čo vyprodukovala AKTUÁLNE
  zobrazené dáta, alebo len "čo je práve rozpísané"? Ak druhé, potrebuje
  vlastný "naposledy odoslané" ref, nie priamy odkaz na live state.
- **Predvolený stav (zbalené/rozbalené, viditeľné/skryté, ...) per PRIEČINOK/
  ZÁLOŽKA v ľavom menu patrí do REGISTRA (`nav.ts`), nikdy ako hardcoded
  zoznam mien/id v `Sidebar.tsx`.** Issue 343 (šéf: "Systém"/"Automatizácie"
  majú štartovať zbalené) pridalo `NavFolder.defaultCollapsed?: boolean` —
  `Sidebar.tsx`'s `collapsed` `useState` sa inicializuje LAZY initializerom,
  ktorý prejde `folders` prop a nastaví `true` len tam, kde je pole
  nastavené. Žiadna zmena `Sidebar.tsx` pri pridaní ĎALŠIEHO priečinka s
  vlastným predvoleným stavom (napr. budúce "Dôležité" z issue 342) — presne
  ten istý princíp ako existujúci `NavTab.wide`/`icon`. Stav sa NEPAMÄTÁ cez
  `localStorage` (na rozdiel od `rail`, issue 190) — to bolo výslovné
  rozhodnutie na tickete (šéf žiadal len predvolený stav, nie pamätanie),
  nie technické obmedzenie; ak by niekedy chcel pamätanie, je to jasne
  ohraničené samostatné rozšírenie toho istého `useState`.
- **Pridanie ĽUBOVOĽNÉHO nového viditeľného prvku (text, odznak, pilulka)
  DOVNÚTRA tlačidla/hlavičky, ktoré existujúce testy vyhľadávajú cez
  `getByRole("button", {name: "presný text"})`, potrebuje `aria-hidden="true"`
  na tom novom prvku, INAK sa zmení PRÍSTUPNÝ NÁZOV tlačidla a všetky
  exact-name dotazy naprieč testami (unit aj e2e) prestanú sedieť.** Issue
  343 (code review nález, PR 348): pridanie súhrnného odznaku "34" priamo do
  `.folder-head` tlačidla "Automatizácie" (súčet `badgeCounts` vnútri, keď je
  priečinok zbalený — rovnaká `.tab-badge` trieda ako existujúce vnútorné
  odznaky, `.folder-dot` malá bodka keď je súčet 0 ale niečo má
  `badgeStatus`) by BEZ `aria-hidden` zmenilo accessible name tlačidla z
  `"Automatizácie"` na niečo ako `"Automatizácie 34"` — rozbilo by to
  DESIATKY existujúcich `page.getByRole("button", {name: "Automatizácie"})`
  klikov naprieč e2e sadou. `aria-hidden` na dekoratívnom doplnku ponecháva
  názov tlačidla presne taký, aký bol; obsah je stále VIZUÁLNE prítomný, len
  sa nepočíta do accname algoritmu. Overené `getByTestId`, nikdy `getByRole`
  dotazom, na nový doplnkový prvok samotný. Akýkoľvek FUTURE "pridaj malý
  vizuálny indikátor do existujúceho pomenovaného tlačidla" potrebuje rovnakú
  kontrolu: nezmenilo sa accessible name? (over `getByRole` dotazom
  s PÔVODNÝM textom, nie novým).
- **Rovnaké aria-hidden pravidlo platí AJ pre STAVOVÚ PILULKU „Beží"/
  „Zastavené" (`nav-status-<id>`, `Sidebar.tsx`) — a issue 447 dokázalo, že
  jeho vynechanie sa ĽAHKO prehliadne, lebo EXISTUJÚCE pilulkové tab-y sú v
  e2e klikané SUBSTRINGOM, nie `exact:true`.** Pilulka bola od issue 185 BEZ
  `aria-hidden` (posta/order-reminder), ale ich tab-y `nav.spec.ts` klikal
  `getByRole("button", {name: "Nevyzdvihnuté zásielky"})` (substring), ktorý
  toleruje suffix „ Beží" v accessible name. Issue 447 pridalo pilulku na
  restock/sync/supplier-stock — a `restock-waiting.spec.ts`/`restock-events
  .spec.ts` klikajú restock tab `{name: "Vypredané → Skladom", exact: true}`.
  Pilulkin text „Beží" sa zlial do accessible name („Vypredané → Skladom Beží"),
  takže `exact:true` prestal sedieť → `locator.click` timeout 30 s, na VŠETKÝCH
  3 restock e2e testoch. Prešlo dev-push AJ PR CI (nav.spec.ts's nové assercie
  idú cez `getByTestId("nav-status-*")`, nie accname) a spadlo AŽ na main CI /
  bolo chytené rerunom — lebo nav.spec.ts nemá exact-name restock click.
  Fix: `aria-hidden="true"` na pilulke (rovnako ako `ticon`/`folder-badge`),
  text/`nav-status-` testid ostávajú (aria-hidden neovplyvňuje ani jedno).
  **Pri pridaní pilulky/odznaku na NOVÝ tab vždy `grep -rn '<label tabu>",
  exact: true' apps/web/tests/e2e/` — substring-klikané existujúce pilulkové
  tab-y regresiu SKRYJÚ, chytí ju len exact-name klik na PRÁVE opilulkovaný tab.**
- **Súhrnný ukazovateľ (odznak/bodka) na hlavičke ZBALENÉHO kontajnera sa
  počíta z TÝCH ISTÝCH props, čo už vykresľujú originály vnútri — žiadny
  nový sieťový dotaz, žiadny nový stav navyše.** Issue 343: `folderBadgeSum`/
  `folderHasStatus` v `Sidebar.tsx` sú odvodené priamo z `badgeCounts`/
  `badgeStatus`, ktoré komponenta už dostáva ako props (issue 147/185) —
  počítajú sa LEN kým `isCollapsed` (po rozbalení sú vidno originály, žiadna
  duplicita). Prioritné poradie (číslo > bodka > nič) je explicitné
  zadanie na tickete, nie odvodené — pri podobnom "súhrn na zbalenom
  kontajneri" v budúcnosti si vyžiadaj/over presné poradie, nepredpokladaj ho.
- **A per-row visual "state accent" (left border/stripe on SOME rows of a
  list, not all) needs `box-shadow: inset <x> 0 0 <color>`, NEVER a real
  `border-left`, even a "transparent-reserved on every row" one.** Issue
  344 (Nedostupné tovary — vybavené riadky odlíšené farbou): the first
  attempt reserved a 3px `border-left: solid transparent` on EVERY row so
  the state-coloured rows wouldn't "jog" relative to pending ones — but a
  real border still consumes box-model space, and NOTHING else in the same
  card (the group header, the replacement-links list above the rows) got
  the same reservation, so every row ended up ~11px right of the text
  directly above it in the same card (found by code review, not by any
  existing test — this app has NO layout-shift test for horizontal
  alignment, only for row HEIGHT per issues 303/327). Fix: `box-shadow:
  inset 3px 0 0 var(--fs-success)` on the state class ONLY — inset
  box-shadow is purely visual (paints inside the border box, never
  resizes/repositions it), so pending rows need ZERO reservation and there
  is no jog possible, by construction, not by careful measurement. Verified
  live (production DOM read): identical `getBoundingClientRect().left` and
  `.height` for a handled vs. a pending row. **Any future per-row/per-card
  state accent in this app (colour band, status stripe) should default to
  inset `box-shadow`, not `border`,** given how many prior tickets in this
  playbook (105/107/111/127/163/204/214/291/303/327) already fought pixel
  alignment/row-height regressions the hard way.
- **A registered `NAV`/`HIDDEN_TABS` screen that does NOT need role-based
  gating can declare its own props type NARROWER than the shared
  `SectionProps` (`{role, onSessionExpired}`) — TypeScript still accepts
  it as `ComponentType<SectionProps>` because `App.tsx` passes a real
  `SectionProps` OBJECT VARIABLE (`<ActiveComponent role={me.role}
  onSessionExpired={reload} />`), and excess-property checking only
  fires on object LITERALS, never on a wider-typed value flowing into a
  narrower parameter.** Issue 342's `DailyTasksSection` takes only
  `{onSessionExpired}` (since #487 it is a SHARED list — `requireUser` on
  every endpoint, so no `CONTROL_ROLES`-style role check exists in the
  component; it was a private per-`user_id` list at #342, the justification
  changed but the narrow-props shape stayed the same) — no
  cast, no `as SectionProps`, `pnpm typecheck` passes clean. Reach for this
  ONLY when the screen genuinely has no role distinction (server enforces
  ownership/permission some OTHER way); if any role check exists, take the
  full `SectionProps` like every other screen in `nav.ts`.
- **`gap` on a `display:flex` parent is a MINIMUM spacing floor that
  `justify-content: space-between` cannot shrink below — it adds on top of
  the children's own widths even when the parent is nearly full.** Issue
  359 (sidebar collapse toggle moved from a standalone full-width row
  INTO `.brand`, as an icon sibling of the logo): `.sidebar-rail .brand` is
  only 72px wide, and after its own padding the content box is 64px — the
  logo (32px, fixed) + the new icon button (28px, fixed) sum to exactly
  60px, which LOOKS like it fits with 4px to spare. It did not: `.brand`'s
  inherited `gap: var(--fs-space-2)` (6px) is enforced as a MINIMUM gap
  between the two flex items regardless of `justify-content`, pushing the
  real required width to 66px — a ~2px overflow invisible by inspection,
  caught only by an independent review dispatch and confirmed by a live
  `element.scrollWidth > element.clientWidth` check (`.claude/rules/
  frontend-design.md`'s own established measurement pattern, issues
  105/107/111/127/161/214). Fix: `.sidebar-rail .brand { gap: 0; }` — the
  remaining slack is distributed by `space-between` alone, no minimum gap
  fighting it. **Any FUTURE flex row that mixes a real `gap` with
  `justify-content: space-between`/`space-around` in a TIGHT (near-zero-slack)
  container:** the true minimum width is `Σ(children widths) + gap ×
  (children − 1)`, not just `Σ(children widths)` — measure or compute
  that explicitly before trusting `space-between` to "make it fit".
- **A toggle-open inline editor keyed by a single global scalar
  (`editingXId`) whose "open" `onClick` UNCONDITIONALLY reseeds its draft
  from the server value is a silent-data-loss trap** — issue 381 (majiteľ:
  "to emoji ... sa správa hrozne"): `DailyTasksSection.tsx`'s emoji editor
  let only ONE row be open at a time, and the ONLY way to "close" the
  currently-open row was to open a DIFFERENT row's editor — but that same
  `onClick` also unconditionally overwrote `emojiDraft[row.id]` with the
  server value, so a draft typed but not yet saved was silently gone the
  moment you switched away and back (naživo reprodukované, komentár na
  tickete). Fix pattern: seed the draft ONLY if no in-memory entry already
  exists for that id (`row.id in d ? d : {...d, [row.id]: seed}`), and
  explicitly DELETE the draft entry on both successful save AND explicit
  cancel — so a LATER reopen still gets a fresh server value (no
  staleness), but a temporary switch-away-and-back does not lose anything.
  **Two independent per-row toggle-open editors on the SAME row (text vs.
  emoji, each its own `editingXId` scalar) can end up open SIMULTANEOUSLY**
  if opening one never closes the other — found live via Playwright
  against PRODUCTION (not by any existing test) as two duplicate 💾 save
  buttons rendered side by side on one row. Fix: each "open X editor"
  action must ALSO close any OTHER per-row editor open for the SAME row id
  (`setEditingOtherId((current) => (current === row.id ? null : current))`
  inside the "open" handler). **A Cancel/close button added NEXT TO an
  existing Save button on a per-row editor needs the SAME `disabled={busy}`
  guard Save already has** — found by an independent review dispatch, not a
  test written first: without it, cancelling while THIS row's OWN save is
  in flight, then reopening and retyping, lets the ORIGINAL (already
  "cancelled" from the UI's perspective) save's success handler race
  against and silently discard the NEW draft once it resolves — the same
  class of bug the file's existing "latest ref" pattern
  (`editingTextIdRef`/`editingEmojiIdRef`) already guards against for a
  DIFFERENT row switching away, but it also applies WITHIN the same row
  across a cancel+retype cycle. Any FUTURE per-row toggle-open editor
  (draft + Save + Cancel) added to this app needs all three checks: does
  "open" only seed-if-absent (never unconditionally overwrite)? does it
  close any OTHER per-row editor on the SAME row? does Cancel share Save's
  `disabled={busy}` guard?
- **Deleting one dynamic key from a `Record<string,string>` React state
  update triggers `@typescript-eslint/no-dynamic-delete`** (`delete
  obj[dynamicKey]`, this repo's `strictTypeChecked` eslint config) — issue
  381's `emojiDraft` cleanup. The lint-safe equivalent is `Object
  .fromEntries(Object.entries(obj).filter(([key]) => key !== id))`, never
  an `eslint-disable` comment.
- **`grid-template-columns: repeat(auto-fill, minmax(X, 1fr))` squeezes a
  LONE item to a fraction of the container instead of giving it the full
  width — `auto-fit` is almost always what you actually want.** Issue 382
  (`.upozornenia-list`, majiteľ: "nech sa vojde viac vedľa seba, keď je
  miesto"): the first attempt used `auto-fill`, which RESERVES as many
  column tracks as fit the container's width at the given minimum, even
  when those tracks hold no item — a container wide enough for 3 tracks
  with only ONE real card in it still gets 3 equal `1fr` tracks, so the
  one card gets ~1/3 the width instead of the full width. This broke an
  EXISTING e2e test (issue 327's "action row stays on one line") the
  moment a test created just one card — the card's real width dropped
  from ~1300px to ~420px and its button row wrapped to two lines,
  LOOKING exactly like a regression in the button-row CSS itself, when
  the real cause was the grid keyword. `auto-fit` collapses genuinely
  EMPTY tracks to 0 width and lets `1fr` redistribute their share to the
  tracks that DO hold an item — a lone card gets 100% of the width
  (identical to the previous `flex-direction: column` behavior), while N
  cards still sit side by side exactly like `auto-fill` would arrange
  them. Use `auto-fit` by default for a "cards that wrap when there's
  room" grid; reach for `auto-fill` only when you deliberately want
  visible empty slots reserved (rare — a fixed-size palette/swatch grid,
  not a variable-count card list).
- **The `minmax(X, 1fr)` MINIMUM in that same pattern needs a
  `min(Xpx, 100%)` wrapper whenever the container can ever be narrower
  than X — a bare `minmax(500px, 1fr)` overflows on any screen under
  500px, and on a `wide: true` tab (`nav.ts`) that overflow is SILENTLY
  CLIPPED, not scrollable, because `.main-wide` has `overflow-x: hidden`
  (this file, §1).** Found by an independent review dispatch on issue
  382, not by any existing test — confirmed live at 375px
  (`document.documentElement.scrollWidth` stayed pinned to the forced
  minimum while `window.innerWidth` was smaller, meaning content past
  the edge was genuinely unreachable, no scrollbar). Fix:
  `minmax(min(500px, 100%), 1fr)` — identical behavior above 500px
  (`min` picks the 500px branch), but on a narrower container `min`
  picks `100%` instead, so the track shrinks to fit rather than forcing
  overflow. Any FUTURE `auto-fit`/`auto-fill` grid on a `wide: true`
  screen in this app needs this same `min(...)` wrapper — verify with a
  live narrow-viewport check (this file's own established methodology,
  issues 161/190/291), not just a wide-screen screenshot.
- **The exact minimum column width for a "keep this card's inline
  action row on one line" grid floor is NOT a round guess — measure it
  live with `page.addStyleTag` overriding `grid-template-columns` to a
  sequence of candidate PIXEL widths (not percentages), same technique
  as the `<colgroup>` methodology (issues 105/107/111/127) applied to a
  grid instead of a table.** Issue 382's `.upozornenia-actions` (issue
  327's date input + 4 buttons) wraps to two lines below ~490px card
  width — binary-searched live (340→500px candidates) rather than
  assumed, landing on a 500px floor (small margin above the measured
  ~487px threshold). A round guess here would either break the existing
  one-line invariant (too narrow) or needlessly suppress multi-column
  layout on common viewports (too wide, e.g. picking 600px+ "to be
  safe").
- **A NEW nav tab whose label is a strict PREFIX of an ALREADY-EXISTING
  tab's label (`nav.ts`) AND which ALSO carries a left-menu badge count
  cannot be found unambiguously by `getByRole` at all — neither
  `{ exact: true }` nor a plain substring query.** Issue 387 E5's new
  "Párovanie" tab sits alongside the existing "Párovanie produktov" (#239) —
  a classic prefix collision (`.claude/rules/testing.md`'s established
  class, issues 240/311), but this one has an EXTRA twist: `Sidebar.tsx`'s
  badge-carrying `<span>` sets its OWN `aria-label` (`${tab.label}:
  ${count}`) as a CHILD of the tab `<button>`, and a descendant's
  `aria-label` concatenates into the ANCESTOR button's computed accessible
  name — so once the badge attaches (count resolves from `null`), the
  button's real name becomes `"Párovanie Párovanie: 2"`, not bare
  `"Párovanie"`. `{ name: "Párovanie", exact: true }` then finds ZERO
  matches (the real name has the badge suffix); a bare substring query for
  `"Párovanie"` finds TWO matches (both this tab AND "Párovanie produktov",
  since "Párovanie" is a substring of both). Neither Playwright locator
  option resolves it. **Fix: `data-testid="nav-tab-${tab.id}"` added
  directly to `Sidebar.tsx`'s tab `<button>` (additive — every tab gets
  one, unique by construction, zero collision risk with anything
  accessible-name-based)** — `page.getByTestId("nav-tab-<id>")` sidesteps
  the whole accessible-name computation. Test for ANY future nav tab whose
  label is a prefix/substring of an existing one: does it ALSO carry a
  `badgeCounts`/`badgeStatus` entry (`App.tsx`)? If yes, `exact: true` will
  NOT work once the badge is populated (only works for a badge-less tab,
  the `restock-links.md`'s "Vypredané → Skladom" precedent) — reach for the
  `data-testid` instead of trying to out-clever the accessible-name string.
- **A bare single-class selector styling a NEW `<input>` (e.g.
  `.my-checkbox { width: 1rem; }`) silently LOSES to this file's own
  global reset `input:not([type="hidden"]) { width: 100%; ... }` (line
  ~161) — regardless of source order.** CSS specificity: the global
  reset is `input` (1 element) + `:not([type="hidden"])`'s attribute
  argument (1 attribute/class-level) = (0,0,1,1); a bare
  `.my-checkbox` is (0,0,1,0) — ONE class-level component, strictly
  lower, so it loses even though it's defined LATER in the file (tie-
  breaking by source order only applies when specificity is EQUAL).
  Issue 403's `.uloha-done-toggle` hit this converting a `<button>`
  (Unicode ☐/☑) to a real `<input type="checkbox">`: the checkbox
  silently got `width:100%`, stealing nearly the whole flex row and
  squeezing the sibling text span to a computed `width:0` — found via
  live Playwright DOM inspection (`getComputedStyle`/
  `getBoundingClientRect` on a local dev server, not by reading the CSS,
  since a screenshot alone doesn't reveal a 0-width element sitting
  behind a stretched sibling) after a Playwright e2e test reported the
  text as unexpectedly `"hidden"` (a 0-width bounding box reads as not
  visible). **Fix: scope with a PARENT class, not just the element's
  own** — `.uloha-row .uloha-done-toggle` = 2 class-level components =
  (0,0,2,0), which beats (0,0,1,1) unconditionally (class-count 2>1
  decides before the element-count tiebreak is even reached). This is
  the SAME shape as the pre-existing `.order-group input[type="checkbox"]`
  precedent (`app.css` ~line 1202, (0,0,2,1)) — any FUTURE new
  `<input>` styled in this codebase needs AT LEAST 2 class-level
  selector components (a parent-scoped class, or `.class[type="..."]`),
  never a bare single class, or it silently inherits the global
  `width:100%`/border/padding/background reset instead of its own CSS.
- **Pridanie novej VIDITEĽNEJ záložky do `nav.ts` rozbije PEVNÉ počty na
  TROCH miestach naraz — nielen jednotkový `nav.test.ts`, ale aj E2E
  `nav.spec.ts`, ktorý má DVE tvrdenia `page.locator(".side-nav .tab")
  .toHaveCount(N)`** (jedno v rozbalenom menu, druhé v zbalenej lište).
  Issue 437 (nová záložka „Poznámky"): pridanie do priečinka „Dôležité"
  posunulo `nav.test.ts`'s `NAV[0].tabs.toHaveLength(2)` → 3 aj
  `NAV[0].tabs.map(label)` zoznam, A `nav.spec.ts`'s OBA `.toHaveCount(19)`
  → 20 (+ vhodné pridať `getByRole("button",{name:"<label>"}).toBeVisible()`
  k výpočtu záložiek). **Pasca overovania: lokálny beh LEN nového spec
  súboru (`playwright test poznamky.spec.ts`) tieto count-strážcov v
  `nav.spec.ts` NEODhalí** — prešiel zeleno, no CI (celý balík) zhodil
  `nav.spec.ts` na `Expected 19, Received 20`. Pri KAŽDEJ novej/odobranej
  `nav.ts` záložke: `grep -n 'toHaveCount\|toHaveLength\|dvadsať\|devätnásť'
  apps/web/tests/e2e/nav.spec.ts apps/web/src/nav.test.ts` a spusti lokálne
  AJ `nav.spec.ts` (nielen svoj nový spec), inak to chytí až CI. (Meno novej
  záložky navyše kontroluj na substring-kolíziu podľa vzoru issue 240 vyššie.)
- **Rastrové ikony (PWA `icon-192/512.png`, apod.) sa dajú vygenerovať z
  brand SVG cez Playwright chromium, keď na boxe NIE JE `rsvg-convert`/
  ImageMagick `convert`/`sharp`** (issue 437, PWA ikony z favicon značky
  #430). Vzor: `createRequire(".../apps/web/")` → `require("@playwright/
  test").chromium` (pnpm store cesta, nie priamy `import`), `page.setContent`
  s inline SVG (vrátane emoji 🌲 — chromium na `forestshop-dev` má emoji font,
  vykreslí ho farebne), `page.setViewportSize({width:px,height:px})`,
  `page.locator("svg").screenshot()`. Over výsledok VIZUÁLNE (Read na PNG) —
  ak by chýbal emoji font, dostal by si prázdny farebný štvorec, nie strom.
  Rovnaká chromium závislosť ako e2e (`.claude/rules/local-dev.md`'s
  libnspr4 knižnice).
- **Emoji picker (issue 440) je ZNOVUPOUŽITEĽNÝ `EmojiPickerButton.tsx` +
  čistý `insertEmojiAtSelection(value, selStart, selEnd, emoji)` helper —
  žiadna externá knižnica (kurátorovaná sada ~40 emoji, MVP).** Vkladá na
  pozíciu kurzora cez `targetRef.current.selectionStart/End` (funguje pre
  `<textarea>` aj `<input type=text>`); po `onChange` obnoví fokus + caret
  `requestAnimationFrame`om (kontrolovaná hodnota sa prekreslí AŽ po commite
  Reactu, rAF beží po ňom, takže DOM už nesie novú hodnotu a
  `setSelectionRange` sadne). **Popover sa po vložení emoji ZAVRIE
  (`setOpen(false)`) — je `position: absolute` a otvára sa NADOL nad obsahom
  pod poľom; OTVORENÝ popover prekryl a „ukradol" klik na tlačidlo Uložiť pod
  formulárom (nájdené e2e, nie unit — `<button ...>emoji</button> intercepts
  pointer events`).** Zavrieť sa dá aj Escape/klik-mimo (document listener v
  `useEffect([open])`, cleanup oboch). Popover je `role="group"` +
  `aria-label` (NIE `role="menu"`/`menuitem` — to implikuje roving-focus/
  šípkovú navigáciu, ktorú tento ľahký picker nemá; obyčajné pomenované
  tlačidlá `aria-label="Vložiť <emoji>"` sú čestnejšie a e2e ich hľadá cez
  `getByRole("button", {name})`). Zapojenie: `targetRef` (useRef na pole),
  `value`, `onChange`, unikátny `testId` (viac pickerov na obrazovke — napr.
  Nadpis + Podrobnosti upozornenia — inak testid kolízia). Vo formulári s
  STĹPCOVÝM `<label>` (`display:flex; flex-direction:column`) potrebuje
  `.emoji-picker { align-self: flex-start }` (scoped `.upozornenie-form
  .emoji-picker`), inak ho `align-items: stretch` roztiahne na celú šírku —
  ale POZOR ho nedávaj globálne, v ROVNOM riadku (`.poznamka-add-actions`)
  by vertikálne odsadil od súrodenca. Emoji sa v appke ukladajú/zobrazujú
  správne bez akejkoľvek úpravy (Postgres `text` + node-postgres nesú
  4-bajtové UTF-8; zamknuté `emoji-persist.integration.test.ts`
  POST→GET round-tripom vrátane ZWJ rodiny/vlajky/variation selectora) —
  „emoji nefunguje" bol vždy len chýbajúci VSTUP, nikdy perzistencia.
- **`EmojiPickerButton.insert()` MUSÍ čítať bázovú hodnotu zo ŽIVÉHO DOM-u
  (`el.value`), NIE z React `value` prop-u (issue 455).** Prop je snímka z
  posledného renderu; keď používateľ (alebo Playwright `.fill()`) napíše text
  a HNEĎ klikne emoji skôr, než React skomituje onChange poľa, closure `insert`-u
  nesie STARÝ prop (`""`), kým DOM `el.value` už má napísaný text. Výber
  (`selectionStart/End`) sa už čítal zo živého `el`, takže s prop-om bola
  hodnota+caret NEKONZISTENTNÁ dvojica: `insertEmojiAtSelection("", 19, 19, "✅")`
  oreže caret na dĺžku 0 → vráti holé `"✅"` a napísaný text sa STRATÍ. Prejavilo
  sa to len ako nedeterministický CI flake (`upozornenia.spec.ts:271`), lokálne
  skoro vždy prešlo, lebo React zvyčajne stihne flush medzi dvoma Playwright
  príkazmi. Fix = `const base = el !== null ? el.value : value;` (a
  `selStart/End ?? base.length`), takže hodnota + caret sú jedna konzistentná
  synchrónna snímka DOM-u; na prop sa spadne len keď element neexistuje. Nulová
  zmena v happy-path (`el.value === value` prop). Deterministický regres:
  `EmojiPickerButton.test.tsx` „issue 455" `StaleHarness` (uncontrolled `<textarea
  defaultValue="">`, ručne `ta.value=` PRED prázdnym prop-om → assert `onChange`
  dostane celý text + emoji). **Vzor pre ktorýkoľvek insert-at-cursor helper nad
  controlled poľom:** čítaj hodnotu aj výber z toho ISTÉHO `el` v jednom
  synchrónnom momente, nikdy nemiešaj DOM-výber s prop-hodnotou.
- **`EmojiPickerButton` obnovuje fokus + caret v `requestAnimationFrame`, ale
  smie fokus vrátiť LEN keď je stále „náš" — inak oneskorený rAF UKRADNE fokus
  (issue 455, hlbšia príčina flaku `upozornenia.spec.ts:271`).** rAF vystrelí až
  keď kompozítor vyrobí snímku; na zaťaženom (CI) stroji to zaostane o stovky ms,
  kľudne až do chvíle, keď sa používateľ — alebo Playwright `.fill()` DRUHÉHO
  poľa (dvojkroková `focus`→`insertText` operácia) — už presunul inam.
  Bezpodmienečný `target.focus()` v rAF vtedy skočí SPÄŤ na pôvodné pole a text
  sa napíše do zlého poľa (v teste: „Skontrolovať sklad" skončí v NADPISE, pole
  podrobností ostane prázdne → emoji vyjde ako holé „✅", stabilne, presne flake
  z CI). **Guard:** rAF callback obnoví fokus len keď `document.activeElement` je
  pole samo, náš `rootRef` popover/root, `<body>` alebo `null`; inak `return`
  (žiadna krádež). rAF id sa drží v `useRef` a pri ďalšom inserte aj pri unmounte
  sa `cancelAnimationFrame`-uje (nech oneskorená snímka neukradne fokus po zmiznutí
  poľa). Po `setOpen(false)` sa kliknuté emoji tlačidlo odmountuje a fokus padne na
  `<body>` → bežná cesta (hneď po vložení) sa aj tak refokusne. **e2e vzor:** medzi
  emoji-insert do jedného poľa a `.fill()`/prácu s ĎALŠÍM poľom vlož
  `await expect(<pole>).toBeFocused()` — vypustí čakajúci rAF a zároveň overí
  fokus-kontrakt. `pressSequentially` NIE je oprava (fokusne raz, per-znak píše do
  práve fokusnutého poľa — oneskorený rAF ich presmeruje rovnako); ani post-type
  `toHaveValue` (hazard je čakajúci rAF, nie necommitnutá hodnota). Deterministický
  regresný unit test: stub `requestAnimationFrame`, klik emoji poľa A, `.focus()`
  poľa B, ručne vystrel zachytený rAF, assert fokus ostal na B (RED bez guardu).
- **Nav count BADGE (`nav-badge-<id>`, vzor Upozornenia/#147) naviazaný na
  DB dopyt sa v e2e NIKDY neasertuje presným číslom — zdieľaná e2e DB
  (`scripts/e2e-setup.ts`) seeduje VEĽA objednávok, ktoré kritériu
  vyhovujú, nielen fixtúry danej funkcie.** Issue 445 (DPD badge = počet
  „na objednanie DPD"): `toHaveText("2")` (počítal som s dvomi DPD
  fixtúrami 9012/9013) padlo na CI s `Received "14"` — e2e-setup má ~14
  otvorených objednávok bez `package_number`, ktoré všetky kvalifikujú.
  Lokálny beh len nového spec súboru to nechytil rovnako ako pri
  `toHaveCount` (issue 437) — chytila to až CI. Fix: over len, že odznak
  SVIETI a nesie kladné celé číslo (`toHaveText(/^[1-9]\d*$/)`) — presnú
  sémantiku počtu pokrýva API integration test s RIADENÝMI dátami, nie
  e2e proti zdieľanej seed DB. Platí pre KAŽDÝ budúci count badge.
- **PROD DB sa dá čítať PRIAMO na `forestshop-dev` cez `docker exec` — užitočné
  na živý „pred/po" dôkaz pri overovaní (nielen cez UI).** `docker exec
  forestshop-postgres-1 psql -U forestshop -d forestshop -c "..."` (kontajner
  s POMLČKOU `forestshop-postgres-1` = PROD, bez host portu; s PODTRŽNÍKOM
  `forestshop_app-postgres-1` = lokálna dev DB na 5433, `.env`). Issue 445
  tak doložilo, že stavový filter znížil ponuku DPD z 297 na 40 (257
  terminálnych vylúčených) — presne šéfovu výhradu. Len ČÍTANIE, žiadny zápis
  na PROD bez schválenia (`no-destructive-remote-actions.md`).
- **Appkin JEDINÝ červený BUTTON variant je `.btn.bad` (`app.css:733`,
  `--fs-danger-bg` pozadie + `--fs-danger` text, pridaný issue 387 E6) — a je
  DNES v žiadnom `.tsx` NEINŠTANCOVANÝ, lebo jeho pôvodné „✗ Zlé" tlačidlo bolo
  medzitým odstránené (`PairingReviewCard.tsx` komentár, commit `f45af65`).**
  Keď šéf inde v appke povie „daj tlačidlo červené" (issue 466 — odoslané
  tlačidlo v Nedostupných): prepni jeho variant `ghost` → `bad`, NIKDY nezavádzaj
  novú surovú/priesvitnú farbu (zakázané `--fs-*` token pravidlom vyššie).
  DVE pasce: (1) `grep .btn.bad apps/web/src` dnes nič nenájde — to NEznamená, že
  červený button token neexistuje, len že ho nikto práve nepoužíva; je to
  DEFINOVANÝ variant vedľa `.btn.good`/`.btn.ghost`/`.btn.warn`, plnohodnotne
  použiteľný. (2) Delete/„✕ zmazať" tlačidlá v appke sú `btn sm ghost` (SIVÉ), NIE
  červené — takže NIE sú referenciou „červenej, ktorú používame na tlačidlách";
  tou je práve `.btn.bad`. Varianty sa používajú VÝHRADNE vzájomne (`btn lg bad`,
  nie `btn lg ghost bad` — stack by nechal ghostov `border-color`). Pozn.: červená
  inde na tej istej obrazovke znamená CHYBU (BCC/mail varovania, issue 344 preto
  pre RIADOK zvolil zelenú `--fs-success`) — pri „daj to červené" over, či to šéf
  myslí naozaj (issue 466: myslel, výslovne zopakoval), a zdôvodnenie napíš na tiket.

- **Badge v nav tabe mení accessible name tlačidla** (#512): číselný badge je
  `<span>` s `aria-label` VNÚTRI tab buttonu, takže jeho text sa PRIDÁVA do
  accessible name — `getByRole` kliky s NEexact menom v e2e ostávajú bezpečné,
  exact-name kliky by sa rozbili. Pri pridávaní badge na existujúci tab netreba
  meniť nav counts logiku, len over e2e selektory tabu.
- **Zdieľaný "stale-response guard" (ochrana pred prepísaním novšieho výsledku
  ZASTARANOU odpoveďou staršieho fetchu — "latest ref" trieda vyššie, issue
  151/251/254/264) je od issue 523 hook `apps/web/src/useStaleResponseGuard.ts`
  — KAŽDÝ ĎALŠÍ komponent s filter/parametrom-riadeným fetchom ho MÁ POUŽIŤ,
  nie znova vynachádzať inline `useRef(0)` + `const seq = ++ref.current` +
  `if (seq !== ref.current) return` vzor** (rovnaká "použi zdieľaný mechanizmus,
  nevynachádzaj" disciplína ako `useLoadMore.ts` pre stránkovanie). API:
  `guard.begin()` (nový fetch → vráti seq, znehodnotí staršie prebiehajúce),
  `guard.isLatest(seq)` (odpoveď sa smie uplatniť — použiteľné aj v `.then`,
  `.catch`, `.finally` AJ vo vnorenom reťazci ako `UpozorneniaSection`'s
  classify dopyt), `guard.cancel()` (zahoď prebiehajúci fetch pri zavretí
  dialógu/panela, bez začatia nového — napr. `useCustomerContactMail.close()`,
  `PairingReviewCard.closePanel()`). **Komponent s DVOMA nezávislými fetchmi
  zavolá hook DVAKRÁT** (dva samostatné seq čítače — `SearchSection` search+detail,
  `PairingSearchFixTab` search+item). Metódy sú `useMemo([])`-STABILNÉ (nad
  `useRef`), takže sa nemusia dávať do `useCallback`/`useEffect` dependency polí
  a nikdy nerozbijú memoizáciu volajúceho (repo nemá `react-hooks/exhaustive-deps`,
  takže nestabilita by bola TICHÝ runtime bug). #523 zmigrovalo 16 inline výskytov
  v 14 súboroch bez zmeny správania. **NEMIGRUJ ne-guard refy:** `useLoadMore`'s
  paging `genRef` (vlastný hook), live-value `queryRef`/`stateRef`/`searchedQueryRef`
  (synchronizované v render tele — iný účel), `mountedRef` (StrictMode unmount
  guard, ostáva vedľa guardu v kombinovanom `if (!mountedRef.current || !guard.isLatest(seq))`),
  `EmojiPickerButton`'s `rafRef`.
