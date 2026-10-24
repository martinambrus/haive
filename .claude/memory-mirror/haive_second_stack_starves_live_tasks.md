---
name: haive-second-stack-starves-live-tasks
description: Installing a second Haive stack on the shared Docker daemon can fail a LIVE dev task, even though per-install namespacing holds
metadata:
  type: project
---

Before installing a test Haive stack (or pulling release images), CHECK FOR LIVE TASKS:

```
docker exec haive-postgres psql -U haive -d haive -tAc \
  "SELECT status, count(*) FROM tasks WHERE status IN ('created','queued','running','paused') GROUP BY status;"
```

MEASURED 2026-09-09: a Windows test install of v0.2.0 finished booting at 23:19:01, and at 23:20:02
a running dev task's `01c-ddev-env` step failed — `ddev start failed: … container … is not running`,
with the worker log showing ~24 layers stuck at `Pulling fs layer 0B`. A DDEV runner pulls its own
images through the SAME daemon, so it was competing with a ~4.6 GB release pull and a second
ten-container stack.

**Why:** per-install namespacing (`HAIVE_INSTALL_ID`) protects RESOURCES, not CONTENTION, and it
did its job — the uninstall touched only `wintest_*`, and every `haive_*` volume and shared
`ddev/*` image survived. Verify that distinction before blaming the uninstaller: compare the
failure time against when the uninstall actually ran, since the uninstall is the memorable event
and is usually the later one.

**How to apply:** test installs are fine on an idle dev stack. With tasks running, either wait, or
accept that an early deterministic step may fail and need a retry — `01c-ddev-env` is cheap to
retry because it spends no CLI tokens. Same family as
[[haive-host-build-restarts-worker]] (never edit worker source mid-task) and
[[windows-wsl-share-one-docker-daemon]] (one engine, two installs).
