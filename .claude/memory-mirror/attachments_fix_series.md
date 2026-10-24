---
name: attachments-fix-series
description: 'DONE 2026-09-23: #221-#225 fixed orphaned attachment sidecars, invisible archive notes, the untested attachments route, and plan inputs that ignored deletions; all merged and live-verified at zero tokens'
metadata:
  node_type: memory
  type: project
  originSessionId: 4a63120c-9dc0-4fa4-9b6c-fc8a25973f1c
---

Plan: `/home/activit/.claude/plans/refactored-roaming-petal.md` (six PRs; PR 2 folded into PR 3).

| PR   | merge      | what                                                                                              |
| ---- | ---------- | ------------------------------------------------------------------------------------------------- |
| #221 | `8cc37a1e` | attachment route tests; refused upload path answers 403/409, not 500                              |
| #222 | `4f544eba` | archive notes one bounded line, durable across a 00 retry, INCOMPLETE ARCHIVES block              |
| #223 | `4de1ef0d` | a delete removes files it owns (never a directory), sidecars twice, name reservation              |
| #224 | `c07d274e` | the panel shows the note; polls only while an archive awaits expansion on a live task             |
| #225 | `d0ecf8bc` | plan inputs follow deletions by attachment ROW; additions count by kind; empty-greenfield refusal |

Declined review findings (reasons on the PR threads, all under [[found-not-fixed-running-list]]):
#222 mining fan-outs (scope + cost); #223 r4 same-name replacement window (mirror window is worse);
#225 r4/r5 notice snapshot (agents read the live dir at runtime).

**Live verification PASSED 2026-09-23 on the dev stack, zero CLI invocations**: throwaway blank repo +
deferred greenfield plan build parked at "Plan depth". Verified: the one-line note naming a symlink and
a 17-deep member; index bullet; the panel's amber note (Chrome MCP); polling with an unexpanded zip on a
live task and none after cancel; sidecar removed with its document; folder delete took the root-level
expansion member; `x.docx.extracted.md` stored as `x.docx.extracted (2).md`; `withLiveInputs` dropped a
deleted picture's `vision` and rewrote the index; INCOMPLETE ARCHIVES in the notice; a 00 retry kept the
note. Everything deleted afterwards and proved by counts.

Traps met on the way: a `git worktree add -b <b> origin/main` sets upstream to origin/main (unset it
before the first push); an async `where` stub hands `.limit` callers a rejected promise nobody awaits
(vitest "1 error" with all tests green); tsx restarts the api on pulled sources BEFORE `pnpm docker libs`
finishes, so a transient `does not provide an export` SyntaxError precedes the healthy restart.
