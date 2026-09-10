#!/usr/bin/env bash
# Run the visual-regression project inside a PINNED Playwright image, which is the only reason
# the baselines mean anything.
#
# Playwright compares screenshots pixel by pixel, and rendering differs between this repo's WSL2
# dev host and a GitHub `ubuntu-latest` runner — different distro, fonts and hinting, even though
# both report "linux". Nothing in this repo pins that: every service image is node:26-alpine or
# bookworm-slim, none of them carries a browser. So a baseline shot on a laptop and compared on a
# runner would fail on font edges rather than on anything a human changed.
#
# Running the project inside one fixed image on both sides removes the variable entirely. The tag
# MUST track the @playwright/test version in package.json — the image ships browser builds matched
# to its own release, and a mismatch reintroduces exactly the drift this exists to remove. Treat a
# version bump as a baseline-regeneration event.
#
#   bash scripts/visual.sh                      compare against the committed baselines
#   bash scripts/visual.sh --update-snapshots   rewrite them (review the diff before committing)
set -euo pipefail
cd "$(dirname "$0")/.."

# Volatile by nature: bump WITH @playwright/test, never on its own.
readonly PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.62.1-noble"

say() { echo "[visual] $*"; }

# The RESOLVED version, not the declared range: package.json says ^1.62.0 while node_modules holds
# 1.62.1, and it is the installed one whose browser revisions have to match the image's.
installed=$(node -p "require('@playwright/test/package.json').version" 2>/dev/null || echo unknown)
case "$PLAYWRIGHT_IMAGE" in
  *"v${installed}-"*) ;;
  *)
    say "image $PLAYWRIGHT_IMAGE does not match the installed @playwright/test $installed"
    say "bump PLAYWRIGHT_IMAGE in this script and regenerate the baselines"
    exit 1
    ;;
esac

# The stack has to be reachable, and the specs also talk to postgres directly. --network host is
# what makes localhost inside the container mean the same thing it means outside it.
if ! curl -fsS http://localhost:3000/ >/dev/null 2>&1; then
  say "nothing serving on http://localhost:3000 — start the stack first (pnpm docker:dev)"
  exit 1
fi

say "running the visual project in $PLAYWRIGHT_IMAGE"

# --user keeps the baselines owned by whoever ran this rather than by root: they are committed
# files, and a root-owned snapshot cannot be rewritten by the next run. HOME is redirected because
# that user has none inside the image; the browsers live at /ms-playwright and need no home.
exec docker run --rm \
  --network host \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e CI="${CI:-}" \
  -e HAIVE_VISUAL_RUNNER=1 \
  -e PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-http://localhost:3000}" \
  -e PLAYWRIGHT_API_BASE="${PLAYWRIGHT_API_BASE:-http://localhost:3001}" \
  -e PLAYWRIGHT_DATABASE_URL="${PLAYWRIGHT_DATABASE_URL:-postgres://haive:haive_dev_password@localhost:5432/haive}" \
  -v "$PWD":/work \
  -w /work \
  "$PLAYWRIGHT_IMAGE" \
  npx playwright test --project=visual "$@"
