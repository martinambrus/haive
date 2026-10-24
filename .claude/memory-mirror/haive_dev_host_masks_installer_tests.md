---
name: haive-dev-host-masks-installer-tests
description: Installing Haive into a temp folder on the dev machine cannot exercise the pull path — every image is already cached
metadata:
  type: project
---

Running `install/install.sh` into a temp folder on this machine tests the installer's WRITE path
well and its PULL path not at all. MEASURED 2026-09-09: 16 `ghcr.io/martinambrus/haive-*` release
images were already resident from cutting the releases, plus every base image from the running dev
stack — postgres, redis, mailpit and the 9.19 GB `ollama/ollama`. So `docker compose pull`, the step
whose own banner calls it "the slow part", had nothing to fetch and could not plausibly fail.

**Why:** that is the opposite of a first-time user, who downloads ~15 GB. A real defect
(`pull` discarding docker's exit status, so a failed pull exited 0 while printing "Haive is
running") survived local installs on two platforms and was found by a friend on a fresh Mac.

**How to apply:** treat a green temp-folder install as covering the write path only. The failure
branches are covered instead by `install/test/boot-failures.sh`, which stubs `docker` and `curl` so
the pull can be made to fail on demand — extend that rather than trying to un-cache this host.
See [[haive-next-build-on-dev-tree]] for the same shape of problem with `next build`.
