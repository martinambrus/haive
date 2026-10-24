---
name: next-middleware-request-headers-rsc-loop
description: NextResponse.next({request:{headers}}) in Haive's web middleware causes an infinite ?_rsc= refetch loop and a blank page
metadata:
  type: project
---

In `packages/web/src/middleware.ts`, returning `NextResponse.next({ request: { headers } })` —
the documented way to forward a computed request header to Server Components — breaks RSC
navigation on this Next version. MEASURED 2026-09-09: one browser visit to `/settings/account`
produced 1013 `GET /settings/account` hits in 40s (`docker logs haive-web`), Chrome showing the
same `?_rsc=<token>` URL re-requested forever and rendering a blank page. Reverting that single
line to `NextResponse.next()` → 1 request. A plain `curl` of the same URL is always fine, so
this is invisible outside a browser.

**Why:** A Server Component cannot learn which route it is rendering, so "pass the pathname down
from middleware" is the obvious workaround. It does not work here.

**How to apply:** When a server component needs the current path, use a small `'use client'`
component with `usePathname()` instead (`components/forced-password-guard.tsx` is the worked
example — it withholds `children` rather than flashing them). Never add request-header forwarding
to that middleware. If a guard reads server data the client can change, call `router.refresh()`
after the mutation or the stale layout keeps enforcing the old answer. See [[haive-dev-login]] for
the browser check.
