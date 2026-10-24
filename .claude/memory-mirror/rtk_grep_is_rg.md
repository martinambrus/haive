---
name: rtk-grep-is-rg
description: "The RTK hook runs grep as ripgrep, whose regex dialect rejects `{{` — the error is followed by a '0 matches' line that reads like a clean result; use /usr/bin/grep -F for literals"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 30519ee1-6515-4c11-a33c-53e31117a3e4
  modified: 2026-09-19T09:50:23.539Z
---

MEASURED 2026-09-18: `grep -n '{{' docs/plans/...` printed `rg: regex parse error ... repetition
operator missing expression`, then `0 matches for '{{'`. The same search through
`/usr/bin/grep -n -F '{{'` found the one real hit.

**Why:** the RTK PreToolUse hook rewrites `grep` to `rg`. Rust regex treats `{` as a repetition
operator where GNU grep's basic regex reads it literally, so a pattern that is a plain literal to
grep is a syntax error to rg — and the wrapper still reports a count. A zero from a query that
errored is the silent-zero class: it looks exactly like "nothing there".

**How to apply:** for a literal containing regex metacharacters (`{{`, `(`, `[`, `.`), call
`/usr/bin/grep -F`. Treat any "0 matches" that follows an error line as a failed query, not a result.
Related: [[rtk-docker-logs-summarized]], [[worktree-guard-rtk-git]].
