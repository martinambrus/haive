---
name: aide2-first-wave-series
description: 'AIDE² first wave approved 2026-10-02 under /opus-sonnet — P0 build stamp, #4 diagnosis head cut, P1 parity arm, P2 repeat fact, #5 instructions outside the fence; standing PR-cycle authorization for these five only; ledger .claude/tmp/aide2/ledger.md'
metadata:
  node_type: memory
  type: project
  originSessionId: 2b081b8c-5582-4936-a4d5-0f864c64e41f
  modified: 2026-10-03T11:09:21.279Z
---

On 2026-10-02 the user approved the first wave of `docs/plans/aide2-harness-lessons.md`
(plan file `~/.claude/plans/jiggly-leaping-pretzel.md`). Ledger, briefs, harnesses and evidence
live in `/home/activit/haive/.claude/tmp/aide2/` — read `ledger.md` first on any resume.

Approved, one PR per task, in this order: T1 P0 (build stamp, migration 0172), T2 task #4 (07's
fix prompt kept only the 6,000-char TAIL of a diagnosis, so a person's gate-2 words never
reached the fixer — found by the P2 analyst), T3 P1 parity arm (03-plan-sequence context via
`buildPlanExpansionContext`, variable part <= 96k), then T4 P2 (after T2), then T5 #5 (after T4).
T1-T3 build in parallel worktrees `.claude/worktrees/aide2-{p0,diag-head,p1-sequence}`.

**Why:** the user's answers on 2026-10-02: full PR cycle per task (push, PR, Codex rounds until
clean, CI, merge commit); P0's full live check on the dev stack (migrate 0172, one worker restart
with a temporary uncommitted edit and its revert, one local ollama qwen3:1.7b dispatch); fix #5
right after P2.

State 2026-10-03 (session 28d6c55c): T2 merged #395 (d7ad3d40); T1 merged #396 (cf7cc825) after five
Codex rounds, all valid (fileMode/symlinks, sparse, SHA-256, replace refs, LFS), and LIVE-CHECKED on the
dev stack (0172 applied; boot and real ollama run stamp `commit:<HEAD>`, a temp edit gives `tree:<id>` equal
to the host stamp, revert restores); T3 merged #397 (b94c2b89), the helper now drops its most distant
ancestors to keep its cap; T4 merged #401 (9998fe42). Lesson: rebuild a worktree's libs after every
rebase (stale shared dist failed main's new test after a rebase).

T5 DONE 2026-10-08: PR-A #436 (merge 57d99748: `guidance` field, DDEV advice via `AdvisedStepError`) and
PR-B #437 (merge e3cf9409: cutHead, fenced honored block, 08d source removed by the user's choice, neutral
person framing, bounded cap gate showing guidance), each Codex-clean in round 1. The FIRST WAVE IS COMPLETE.
`~/haive` synced to e3cf9409 the same day; worker boot stamp confirmed. The ruler
(.claude/tmp/aide2/t5/harness) needs the original dev DB (172 cases).

**How to apply:** the push/merge authorization covers these five tasks only. NOT authorized: P1
arm 2 and the live A/B waves (D1) — they need a plan restored on the dev DB (it holds none) and
paid tokens; P3-P8. Found-not-fixed tasks #6-#8 stay open. See [[aide2-bounded-plan-context-evidence]],
[[haive-pr-workflow]], [[haive-opus-sonnet-workflow]].
