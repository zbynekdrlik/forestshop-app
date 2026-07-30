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
