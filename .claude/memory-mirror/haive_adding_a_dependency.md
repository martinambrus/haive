---
name: haive-adding-a-dependency
description: 'Adding a third-party dep needs `pnpm install --lockfile-only` then `pnpm docker rebuild` with NO service — a per-service rebuild leaves a broken symlink into the root .pnpm store'
metadata:
  node_type: memory
  type: project
  originSessionId: 2280e8c6-abbb-42aa-9928-57f6f6e29472
  modified: 2026-09-06T13:38:23.291Z
---

Adding a new third-party package to `packages/web` (or api/worker) takes three steps, and
skipping any of them fails in a way that does not name the cause:

1. Add it to the package's `package.json`.
2. `pnpm install --lockfile-only` on the host — updates `pnpm-lock.yaml` and touches no
   `node_modules`. A plain host `pnpm install` aborts with
   `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` (it wants to purge the modules dir and there
   is no TTY to confirm).
3. `pnpm docker rebuild` with **no service argument**.

**Why:** `pnpm docker rebuild web` looks like the right command and is not. `rebuild_one`
(`scripts/dev.sh:118`) removes only `haive_node_modules_web` + `haive_web_next`, but a
third-party package physically lives in the ROOT store volume
(`haive_node_modules_root` → `/app/node_modules/.pnpm/…`) and `packages/web/node_modules/<pkg>`
is only a symlink into it. So a per-service rebuild produces a **broken symlink**: `ls` shows
the package, `require('<pkg>/package.json')` throws MODULE_NOT_FOUND, and tsc says
`Cannot find module '<pkg>' or its corresponding type declarations` — which reads like a
missing `@types` package. dev.sh even says so ("For a root/shared/database dependency change
use 'rebuild' with no args"); a new dep is one of those.

The image's `deps` stage installs from the lockfile, so step 2 must precede step 3 or the
rebuild reinstalls the old set and nothing changes.

**How to apply:** after the full rebuild, the `db-migrate` one-shot also installs into the
bind-mounted HOST tree, so host `pnpm typecheck` / `pnpm test` see the dep too — check with
`ls node_modules/.pnpm | grep '^<pkg>@'`. Until then, typecheck inside the container:
`docker exec haive-web sh -c 'cd /app && pnpm --filter @haive/web typecheck'`.
See [[haive-libs-build-host-vs-docker]] for the separate dist-ownership trap.
