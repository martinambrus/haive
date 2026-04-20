#!/bin/sh
# Prep /home/node/.claude.json before exec:
#  - Login container (HAIVE_LOGIN_CONTAINER=1): reset to minimal seed
#    (onboarding complete, default theme) and drop any stale .credentials.json
#    so `claude setup-token` skips the welcome/theme picker and starts a
#    fresh OAuth exchange.
#  - Other containers: restore from the volume-persisted _haive_saved.json
#    if one exists, otherwise leave the image-baked seed untouched.
# claude-code writes .credentials.json into /home/node/.claude/, which is a
# named volume, so OAuth tokens persist across teardown automatically.
set -eu
SAVED=/home/node/.claude/_haive_saved.json
TARGET=/home/node/.claude.json
if [ -n "${HAIVE_LOGIN_CONTAINER:-}" ]; then
  printf '{"hasCompletedOnboarding":true,"theme":"dark"}' > "$TARGET"
  rm -f /home/node/.claude/.credentials.json 2>/dev/null || true
elif [ -f "$SAVED" ]; then
  cp "$SAVED" "$TARGET" 2>/dev/null || true
fi
exec "$@"
