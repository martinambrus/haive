---
name: plan-doc-review-depth
description: A plan doc that spells out git or runtime mechanics draws one new Codex finding per mechanism; state the invariant and switch to the structural fix at the second instance of a class
metadata:
  node_type: memory
  type: feedback
  originSessionId: d51aa617-9c0c-47bc-8dc1-76e3e8127108
  modified: 2026-09-27T07:58:04.235Z
---

PR #354 (`kind-riding-dream.md`, scan targets and per-dimension terminals, merged 2026-09-27 as
`c7f146db`) ran 14 Codex rounds with 38 findings, every one valid. Each fix that named a flag or a
mechanism (`--end-of-options`, `checkout-index`, alternates, `--depth`) drew the next finding about
that mechanism. Round 6 switched off a list of git config keys; round 7 found a key the list missed
(`remote.origin.uploadpack`). Replacing the list with one structural rule (every scan git command
runs in a Haive-owned scratch GIT_DIR, the repository's own config never read) closed that class for
good. Round 15 got no review at all (out of allowance) and merged on green CI.

**Why:** a plan that enumerates mechanics becomes a spec reviewers audit line by line, and every
enumerated list invites "you forgot X". A structural rule states what is never read or trusted, and
that has no missing entry to find.

**How to apply:** in plan docs, state the invariant and the mechanism that enforces it (what is
never trusted, what fails closed) rather than a list of flags. When a reviewer finds a second
instance of one class, switch to the structural fix at once rather than extending the list. Expect a
long loop on any plan touching git plumbing, and tell the user whether the rounds are narrowing or
widening. Related: [[haive-pr-workflow]], [[plan-docs-no-amendments]].
