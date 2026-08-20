#!/bin/sh
# Build @haive/database and @haive/shared. Runs INSIDE the dev-libs container.
#
# The container has no USER, so it runs as root and everything it writes onto the bind
# mount lands root-owned — while the developer is uid 1000 and builds these SAME two
# packages on the host, because turbo's `typecheck` and `test` tasks both declare
# `dependsOn: ["^build"]`. Two writers, one directory, and `dist/` is gitignored, so a
# fresh clone gets whichever owner happened to build first. Whoever loses cannot write.
#
# MEASURED: with packages/shared/dist/review root-owned, `pnpm --filter @haive/shared
# build` on the host exits 2 with five `error TS5033: Could not write file ... EACCES`.
# That is `pnpm test` and `pnpm typecheck` failing for a developer who did nothing wrong
# except run `pnpm docker:dev` first — and the error names permissions, so it reads like a
# broken machine rather than a build that has two owners.
#
# Handing the outputs back to whoever owns the repo is the whole fix: the host build then
# always has a directory it can write. It also repairs an already-split checkout, because
# the chown covers dist whatever state it was in.

set -e

APP="${APP_DIR:-/app}"
DIST_DIRS="$APP/packages/database/dist $APP/packages/shared/dist"

# Deliberately not `set -e`-fatal: the outputs still need handing back after a FAILED
# build, or a half-written dist stays root-owned and the next host build cannot repair it.
rc=0
pnpm --filter @haive/database build && pnpm --filter @haive/shared build || rc=$?

# The repo's owner as the container sees it, so no UID/GID has to be plumbed in from the
# host. A mount that cannot represent ownership makes this a harmless no-op rather than a
# build failure — WSL2 plus a Linux-filesystem mount is the supported case (CLAUDE.md,
# Constraints), and that is where it matters.
OWNER="$(stat -c '%u:%g' "$APP" 2>/dev/null || true)"
if [ -n "$OWNER" ]; then
  chown -R "$OWNER" $DIST_DIRS 2>/dev/null || true
fi

exit "$rc"
