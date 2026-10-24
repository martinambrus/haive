---
name: worktree-resolves-shared-from-main-checkout
description: "A .claude/worktrees worker typechecks and tests against the MAIN checkout's packages/shared/dist, not the worktree's — so a stale dist there reads as a missing export in your branch"
metadata:
  node_type: memory
  type: reference
  originSessionId: dc11f5ec-28cf-424a-91d6-7d4fd9d94812
  modified: 2026-10-10T15:01:37.345Z
---

`packages/worker/node_modules` in a worktree is a symlink into the main checkout, and inside
it `@haive/shared -> ../../../shared` resolves to **`/home/activit/haive/packages/shared`** —
the main checkout, never the worktree's copy. So `tsc` and `vitest` in a worktree read the
MAIN checkout's `packages/shared/dist`, whatever the worktree's own `src` and `dist` say.

**Why:** a symbol added to `@haive/shared` on main reads as `TS2305: Module '"@haive/shared"'
has no exported member 'X'` in every worktree until someone rebuilds the MAIN checkout's
shared. MEASURED 2026-09-22: `startsWithSegments` (exported from
`shared/src/cli-providers/catalog.ts`, re-exported through the barrel) was present in the
worktree's own `dist` and absent from the main checkout's, and `pnpm --filter @haive/shared
build` run _inside the worktree_ did not help. It failed 23 tests across 6 files
(`tool-usage*`, `codex-*`, `stream-json-collector`) purely by breaking the module load, and
CI was green the whole time because CI installs and builds fresh.

**It is not only a test problem — a stale dist KILLS THE RUNNING WORKER.** MEASURED
2026-09-23: a `git pull` of main brought worker source importing `startsWithSegments`, `tsx
watch` restarted, and the worker died at startup with the same `SyntaxError` while its container
still reported `running`. It had been down for minutes with nothing flagging it. So the symptom
to recognise is a container that is up with a dead process inside — read `docker logs
haive-worker`, do not trust `docker ps`.

**The fix is `pnpm docker libs`** (one container writer, chowns `dist` back). It takes ~2 minutes,
the worker restarts itself off the rebuilt dist, and the 23 failures and the `tsc` error vanish
together — VERIFIED, worker went 23 failed / 4,955 passed to **0 failed / 4,978 passed** with a
clean `tsc`. Check for running tasks first ([[haive-host-build-restarts-worker]]).

**How to apply:** when a worktree reports a missing `@haive/shared` export, check
`/home/activit/haive/packages/shared/dist` before believing it, and do not describe it as "my
checkout predates the export" — the worktree's source is fine, the main checkout's BUILD is
stale.

A second consequence worth remembering: a change you make to `packages/shared/src` **in a
worktree** is invisible to that worktree's worker tests. Cover it with a test in
`packages/shared`, which does resolve its own source.

**The way out — give the worktree its own install.** MEASURED 2026-09-23: a worktree made by
EnterWorktree starts with NO `node_modules` at all (the symlinks above were made by hand in
earlier sessions). `pnpm install --frozen-lockfile --offline` inside it finished in 3.6 s, reusing
all 575 packages from the store (hardlinks, no download), and `readlink -f
packages/api/node_modules/@haive/shared` then resolved to the WORKTREE's own `packages/shared`.
Then run `pnpm --filter @haive/database build` and `pnpm --filter @haive/shared build` in the
worktree. After that a new shared export is visible to that worktree's api/worker tests with no
`pnpm docker libs` and no merge first. The install's `prepare` runs husky, which rewrites the
shared `core.hooksPath` to the value it already had (`.husky/_`).

**Branch-local schema/shared changes without touching main's dist (2026-10-10, PR #485):** make
each `packages/<pkg>/node_modules` in the worktree a REAL directory whose entries symlink to the
main checkout's, except `@haive/<sub>` which point at the worktree's own `packages/<sub>`. Then
build `database` then `shared` inside the worktree and api/worker/web typecheck and test against
the branch. One-loop Python script (the guard refuses shell loops); `.git/info/exclude` already
covers `/packages/*/node_modules`. Running the worktree's web for a browser check: Turbopack
refuses node_modules symlinked outside its project root, so use `next dev --webpack -p <port>`.

See [[haive-libs-build-host-vs-docker]].

2026-10-23 (#313 PR #847): a fixer changed packages/shared/src and reported "api suite passed", but the api tests had loaded the OLD shared dist. CI (which builds shared first) went red with 5 api 500s. After ANY edit under packages/shared/src or packages/database/src, run `pnpm --filter @haive/shared build` (or database) in that worktree BEFORE running api, worker or web tests, and put that step into fix briefs.
