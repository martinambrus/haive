---
name: haive-next-build-on-dev-tree
description: Running `next build` in packages/web rewrites the tracked next-env.d.ts and shares .next with the running dev server
metadata:
  type: project
---

`pnpm --filter @haive/web build` is the way to check a route's rendering mode (`ƒ` dynamic vs `○`
static) or catch build-only errors, but it has two side effects on this repo's dev setup:

- It rewrites the TRACKED `packages/web/next-env.d.ts` from the dev import paths
  (`./.next/dev/types/...`) to the production ones (`./.next/types/...`). `git checkout --` that
  file afterwards; `next dev` regenerates the dev variant on its next start.
- `next dev` (in the `haive-web` container) and `next build` share `packages/web/.next`. Nothing
  broke when measured — the dev server recompiled and kept serving — but check
  `docker logs haive-web` and a live page after building rather than assuming.

**Why:** the build is genuinely useful (it is how the three `(auth)` routes were confirmed
`force-dynamic`), so the answer is to run it and clean up, not to avoid it.

**How to apply:** build, read what you needed, then `git status` and revert `next-env.d.ts`. Leave
the stale `.next` production output alone — deleting it while the dev server is running is the
larger risk. See [[haive-libs-build-host-vs-docker]] for the analogous `packages/*/dist` case.
