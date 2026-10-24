---
name: found-not-fixed-sweep-2-series
description: 'SHIPPED 2026-09-26 (#301-#325): 24 PRs plus follow-up 20b clearing the consolidated found-not-fixed list (START claim, re-drivers, escaped runs, Stop tx, merge fixer, verified deletes, rollback absence, bundles, images, RTK, phone fit); user decisions, PR map, review outcomes'
metadata:
  node_type: memory
  type: project
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-09-26T04:13:43.437Z
---

Plan: `/home/activit/.claude/plans/compiled-noodling-squid.md` (approved 2026-09-25; it overwrote
sweep 1's plan, whose repo copy is `docs/plans/found-not-fixed-sweep.md`). Repo copy goes to
`docs/plans/found-not-fixed-sweep-2.md`, NOT the slug (that name in docs/plans is the shipped
agent-rules plan). One task per PR in session 3813bbf6 (#52-#75 = PRs 1-24).

**Origin:** after sweep 1 shipped (#267-#300), the parallel recovery session finished (H1-H8, last
#297 `1bd479f2`) and, at the user's request, handed its whole found-not-fixed list to this session.
[[found-not-fixed-running-list]] is the one record; every entry was re-verified on `1bd479f2`.
Its smoke containers stay for reuse: `h1-smoke-pg` (127.0.0.1:55432, trust auth, DBs `haive`,
`haive_h5` at migration head) and `h1-smoke-redis` (127.0.0.1:6392).

**User decisions (2026-09-25):**

- Merge fixer: only a fixer that FINISHED CLEANLY (`exitCode === 0 && !errorMessage`) commits; one
  that crashed/timed out/failed is aborted and re-dispatched, spending an attempt. H6's rules for
  superseded runs stay (never-answered → abort + refund; parsed superseded → completion).
- Ended tasks: step Retry, Skip and fan-out Resume refuse cancelled AND completed tasks (409). The
  user first picked "cancelled only"; I re-asked after finding the task page already hides every
  step action on both (`tasks/[id]/page.tsx:3507-3522`, worktree may be gone), and they switched.
- RTK off + edited settings.json: the upgrade OFFERS "remove the RTK hook", unticked by default;
  picking it strips only that hook entry; rollback restores the bytes.

**Order:** 1 (lockfile) first; 2-8 orchestration; 9-10 merge fixer; 11-13 data safety; 14-18
leftovers; 19-21 RTK; 22-23 web; 24 tests. Dependencies: 3 and 6 need 2; 5 needs 4; 10 needs 9;
12 and 13 need 11; 16 needs 15; 20 after 19.

**Design facts not to re-derive (verified while planning):**

- The api Retry supersedes runs BEFORE it updates step rows (`steps.ts:110`, `:122`, rows after
  `:129`), with no lock first; so PR 4 = ownership-checked inserts + a SECOND sweep after the row loop.
  Reordering the Retry instead would deadlock against `writeStepSummary` (run lock, then step).
- The forward walk takes its round from the finished row (`task-queue.ts:1187`), so START's claim
  may point at `steps[0]`/0 safely; that also fixes the lost pause-branch advance after a Retry.
- A lost cli-exec job cannot be rebuilt from its row (no spec stored): re-drive like boot does.
- The merge fix prompt asks for no JSON, so `uncertain` never fired before PR 10.
- `ws` specifier gap does not break a frozen install (root override recorded).
- `onboarding_artifacts.task_id` is NOT NULL: blank-scaffold RTK files are recognised by bytes.
- Rollback absence needs no migration: 02's persisted step output records created paths.

**Progress (2026-09-26):** all 24 PRs merged (#301-#324, main at `e6e6a089`, each live-checked).
PR number map: T1 #301, T2 #302, T3 #304, T4 #303, T5 #306, T6 #307, T7 #305, T8 #308, T9 #309,
T10 #311, T11 #310, T12 #316, T13 #317, T14 #312, T15 #313, T16 #318, T17 #314, T18 #315,
T19 #322, T20 #324, T21 #323, T22 #320, T23 #321, T24 #319. PR 20's live check found a REGRESSION
of #324 (a rollback that put back a removal also warned "nothing to revert"): follow-up 20b, #325,
Codex clean on round 1, merged as `2a610d56` and live-verified on the dev stack (the worker's tsx
watch missed the pull; `pnpm docker restart worker` after the active-task check). Its docs commit
marks the series SHIPPED. Final verification: smokes on `h1-smoke-pg` back to zero, browser pass
at 375/768/1280 clean, fixtures removed. Review outcomes not to re-litigate:

- #318: a removal waits out a build of its tag, a build whose provider is gone removes both its
  tags, and removal and cache hit take turns per tag (`withImageTagLock`).
- #314: the e2e repo cleanup asks the api on every poll; never wait on `cloning` (a queued clone
  job that finds no row writes nothing, since every root writer claims before touching disk).
- #324: a removal's baseline is written BEFORE the removal (retry vs a person's parked-form
  deletion); upgrade-status reports row-less RTK settings files (`rtkSettingsLeftovers`) under
  01's exact chain and one shared predicate (`holdsRtkSettings`); a repo with an upgrade to roll
  back answers as onboarded. A never-onboarded repo stays bannerless on purpose: POST /tasks
  answers 409 to its upgrade.

Related: [[found-not-fixed-sweep-series]], [[recovery-context-followups-series]],
[[haive-pr-workflow]].
