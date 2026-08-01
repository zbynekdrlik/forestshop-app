---
paths:
  - "apps/api/src/http/**"
---

# HTTP routes (Hono)

- **A literal-path route under a prefix that already has a parameterized
  sibling (`/:id`) MUST be registered BEFORE that parameterized route.**
  Hono matches routes in REGISTRATION ORDER, not by specificity — `app.get("/api/orders/:id", ...)`
  registered before `app.get("/api/orders/open-statuses", ...)` means a
  request for `/api/orders/open-statuses` matches `:id = "open-statuses"`
  FIRST, fails the param's `z.string().uuid()` validation, and never
  reaches the intended handler at all (found live, issue 59 — the response
  was a confusing `ZodError` on `path: ["id"]`, nothing about the actual
  route). Fix: put every literal-path sibling ABOVE the `:param` route in
  the same file (`orders-routes.ts` now has both `GET`/`PUT
  /api/orders/open-statuses` registered before `GET /api/orders/:id`).
  **No unit or integration test caught this** — those call the module
  function directly or hit the route with a valid UUID, never through the
  full route table with a non-UUID literal segment. The ONLY thing that
  surfaced it was the local e2e run against the real dev server. When
  adding a new literal-path route under an existing `:id`/`:param` prefix
  in ANY `http/*-routes.ts` file, check the registration order before
  assuming "the route exists" means "the route is reachable".
- **A `.refine()` chained onto a `z.string()` schema (after `.url()`/
  `.regex()`/`.max()`) still RUNS and adds its OWN issue even when an
  EARLIER check on the same field already failed** — zod does NOT
  short-circuit a string schema's checks on first failure; all of them
  execute and their issues accumulate into one `ZodError.issues` array
  (verified empirically, issue 153: `z.string().url().regex(/^https?:\/\//)
  .refine(...)` parsed against `"=cmd|calc"` returned THREE issues —
  `invalid_string`/url, `invalid_string`/regex, AND the custom `.refine()`
  message — not just the first one). This is what makes it possible to add
  a NAMED, independently-testable `.refine()` guard even when it is
  logically REDUNDANT with an earlier check for every value that can reach
  it (e.g. a formula-injection reject on a field already anchored to
  `^https?:\/\//` — a formula-leading string can never also start with
  `http`, so the two checks always fail TOGETHER) — a test can still assert
  the SPECIFIC custom message appears in `result.error.issues`, proving that
  exact guard fired, decoupled from whichever other check also failed.
  `@hono/zod-validator`'s default (no `hook`) surfaces the whole
  `SafeParseReturnType` as the 400 body (`c.json(result, 400)`), so
  `(await res.json()).error.issues` is where an integration test reads this
  from.
