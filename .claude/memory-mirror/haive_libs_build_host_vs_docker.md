---
name: haive-libs-build-host-vs-docker
description: 'dev-libs runs as root on the bind mount, so shared/database dist can end up root-owned and break host builds; scripts/build-libs.sh chowns it back'
metadata:
  node_type: memory
  type: project
  originSessionId: b26df9dc-f132-47d6-b0c0-4ff6cb96fedd
  modified: 2026-08-20T11:04:58.640Z
---

`@haive/shared` and `@haive/database` are built by two different users, and their `dist/`
is gitignored so a fresh clone gets whichever built first:

- the `dev-libs` compose service, which has no `USER` in its image and so runs as **root**,
  writing onto the `.:/app` bind mount;
- the developer on the host (uid 1000), because turbo's `typecheck` and `test` tasks both
  declare `dependsOn: ["^build"]` — so `pnpm test` and `pnpm typecheck` build these two
  packages on the host.

**Why:** whoever loses the race cannot write. MEASURED 2026-08-20: with
`packages/shared/dist/review` root-owned, a host `pnpm --filter @haive/shared build` exits 2
with five `error TS5033: Could not write file … EACCES`. The message names permissions, so
it reads like a broken machine rather than a build directory with two owners. It bites a
developer who did nothing but run `pnpm docker:dev` before their first `pnpm test`.

**How to apply:** `scripts/build-libs.sh` (what `dev-libs` runs) chowns both `dist` dirs back
to the repo's owner after every build, including a failed one, so the host build always has
a directory it can write — and it repairs an already-split checkout. If a host build ever
fails with TS5033/EACCES under `packages/*/dist`, run `pnpm docker libs` and retry; do not
chown by hand. Host `tsc --noEmit` and `vitest` were always safe — they emit nothing.

Do NOT claim tsc "caches" or "replays" a write failure into `.tsbuildinfo`: TESTED, after
fixing the permissions the very next build succeeds with no source change, and a container
build succeeds with a post-failure buildinfo left in place. An earlier session asserted that
replay mechanism and it did not reproduce.

Related: [[haive-dev-login]]
