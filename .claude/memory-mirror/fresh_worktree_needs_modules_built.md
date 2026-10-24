---
name: fresh-worktree-needs-modules-built
description: a fresh haive worktree must build web-kit and ./modules/* (not only database+shared) before worker/api typecheck or tests
metadata:
  node_type: memory
  type: project
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-14T21:58:12.876Z
---

A fresh worktree's worker and api typecheck and tests fail to resolve `@haive/module-statistics/manifest` until the module packages are built. Since the modularity series, `pnpm install` plus building `@haive/database` and `@haive/shared` is no longer enough. Also run `pnpm --filter @haive/web-kit build && pnpm --filter './modules/*' build`. The outputs go to gitignored `dist/`, which is what CI builds too.

**Why:** found 2026-10-14 by the B3.1b-3 builder in worktree b31b3. It lost time before it found the cause. The modules' manifests are imported by worker/api code.

**How to apply:** when setting up a worktree for a builder, run all four builds before launching it: database, shared, web-kit, modules. Repeat them after merging main into the worktree. Related: [[worktree-resolves-shared-from-main-checkout]], [[fresh-worktree-skips-lint-staged]].
