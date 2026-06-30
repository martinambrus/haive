---
name: rr
description: Rebuilds and reloads the current project.
---

# /rr

Rebuild and reload the current project by using the relevant build and reload mechanics for it.

For the Haive dev stack this is `bash scripts/dev.sh restart` (or `restart <service>` to recreate one service, `rebuild` after a dependency change, `reset` to recover a stale build). See `scripts/dev.sh help`.
