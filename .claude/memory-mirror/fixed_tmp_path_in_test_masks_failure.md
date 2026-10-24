---
name: fixed-tmp-path-in-test-masks-failure
description: 'A test using a hardcoded /tmp path passes locally off a directory an earlier run left behind, and fails only on a clean CI runner'
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-17T08:56:26.987Z
---

A test fixture that hardcodes a path like `/tmp/haive-skill-floor` instead of calling `mkdtemp`
creates that directory on its first run and then REUSES it forever. Every later local run passes
because the directory is already there — including runs of code that no longer creates it. A clean CI
runner has no such leftover, so the same commit fails there and nowhere else.

**Why:** it cost a CI round trip on PR #136. Converting `mkdir(dir, { recursive: true })` to
`writeFileNoFollow(anchor, rel, …, { createParents: true })` changed a precondition — `createParents`
creates parents UNDER the anchor, while `walkDir` opens the anchor itself, so the anchor must now
pre-exist, where `mkdir -p` had created the whole chain including it. Five cases failed on CI with
`ENOENT ... open '/tmp/haive-skill-floor'`; locally all 344 files / 4687 tests passed, because that
directory had been sitting in `/tmp` since an earlier run. Format check and Typecheck both passed, so
nothing before the test step could have caught it.

**How to apply:** when a local suite is green and CI fails with ENOENT on a path under `/tmp`, check
whether the path exists on this host (`ls -ld`) before theorising — if it does, and it holds only the
test's own output, that is the answer. Fix the FIXTURE with `mkdtempSync`/`mkdtemp` plus cleanup, not
the source: a write primitive inventing a repository root would be the actual bug. To verify
honestly, delete the stale directory FIRST and watch the failure reproduce, then fix — otherwise the
green run afterwards proves less than it looks. `grep -rlE "'/tmp/[a-z-]+'"` over the test tree finds
the others.

Related: [[ci_uid_differs_from_dev_host]], [[haive_dev_host_masks_installer_tests]],
[[gh_run_watch_exit_status_lies]].
