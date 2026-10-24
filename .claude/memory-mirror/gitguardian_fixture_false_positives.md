---
name: gitguardian-fixture-false-positives
description: "GitGuardian's PR check flags id-derived fixture strings as secrets, and my PR watcher did not show app check-runs; build fixtures from patterned uuids and read the gitguardian conclusion before merging"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-09-27T02:38:51.550Z
---

GitGuardian scans every commit in a PR and fails its check on a "Generic High Entropy Secret".
MEASURED on #349 (2026-09-27): three test fixtures tripped it, `haive_ide_ext_0e2b35cd1111`,
`haive_cli_auth_goneuser0001_zai_k_1` and `haive_cli_auth_p_99b39acba6d1_gemini_0`, while
patterned uuids (`aaaaaaaa-1111-4111-8111-111111111111`) and names the builders made from them
passed. Two of the three came from real row ids on the dev install.

**Why:** the check was invisible to `pr_watch_retry.sh` (it listed workflow runs only, and
GitGuardian is an app check-run), so #349 stayed red through a full Codex round unnoticed. A
follow-up commit does not clear it: the check scans the PR's whole range, so the flagged commit
had to be rewritten (amend + `--force-with-lease`). The incidents stay "Triggered" in the owner's
GitGuardian workspace until they mark them false positives.

**How to apply:** in tests, build names through the real builders (`cliAuthVolumeName`, ...)
from patterned fabricated uuids, and never derive a fixture from a real local id. The watcher now
prints `apps=[...]` (every non-actions check-run); read GitGuardian's conclusion there before
merging. The `github-advanced-security` check ("Code scanning AI findings") fails on every PR with
`CAPIError: 400 The requested model is not supported`: GitHub's own Autofind, not a code failure
(see [[found-not-fixed-running-list]]).

MEASURED 2026-10-15 on #747: the "Username Password" detector flagged a test fixture pair
(`appAuthUsername: 'ci-user', appAuthPassword: '<literal>'`, and the same two typed one line apart).
Fix that worked: a runtime value (`const TYPED_PASSWORD = crypto.randomUUID()`) in place of the
literal, applied to EVERY commit of the branch with `git filter-branch --tree-filter <script> --
HEAD ^<main sha the branch merged>`. A plain `<branch base>..HEAD` range also walked main's commits
that came in through the merge and rewrote GitHub's signed "Merge pull request" commits (the
signature drops, so every hash changed): reset to the saved head and use the `^<main>` form. The
session's `ci_watch.sh` listed workflow runs only; it now prints `apps=[...]` too.
