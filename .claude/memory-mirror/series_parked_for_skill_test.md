---
name: series-parked-for-skill-test
description: '2026-10-16 the user parked the FNF/Track B task list after the in-flight tasks finish, to test a more efficient skill; start nothing new until they say so'
metadata:
  node_type: memory
  type: project
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-17T13:45:10.850Z
---

On 2026-10-16 the user said: "let's finish the tasks we have open now and then park here, since I'm testing a more efficient skill to work on these and I'd like to wait on those tests before we continue".

**Why:** the user is trying a different, cheaper way to work through the backlog, and wants its results before more tokens go into the old /opus-sonnet loop ([[haive_opus_sonnet_workflow]]).

**How to apply:**

- In flight at park time, all FINISHED 2026-10-17: #274 (#806 f5b849a50), #269 (#807), #282 (#805), #285 (#798 61481e19b), #289 (#802), RAG P1 #142/#143 (#815 83af0e675). The last rounds ran on CI only: the user turned Codex off ("we ran out of Codex allowance - exclude Codex checks until I tell you (only check CI)"), see [[haive-pr-workflow]].
- Decisions taken at the park (2026-10-17), all queued, none started: D22 #286 item 4 — fence the whole open-merge window; D24 #307 F1 — a clone records an RTK choice only when the record carries settings/rtk-enabled.json; D25 #307 F2 — a never-chosen install adopts a teammate's recorded value. The RAG P1 re-eval on the shipped chunker was approved and run; its numbers are in docs/plans/rag-retrieval-improvements.md via #829 (1f5f9f3b1), and both scratch stores were dropped on the user's word.
- Do not start anything else, even when it is briefed. #306 has a brief at `.claude/tmp/track-b/b3/p306/brief.md`, #270 an analyst brief at `p270/analyst-brief.md`, and #304 has facts scoped in the ledger. All three are unlaunched.
- WORKFLOW CHOSEN (user, 2026-10-17, final): keep the session on Opus at max and run `/sonnet-sonnet` per task. Its
  fallback launches one Sonnet max `Drive: <task>` agent per task (Sonnet medium builders); the driver files nothing
  and returns verified found-not-fixed items with a proposed bundle; the Opus session reads each diff and touched code
  for its own items (catches what Sonnet drivers miss, e.g. best-effort audit rows), files everything by bundle, then
  pushes. Pass the open bundle heads in each driver prompt. Unmeasured: pilot the first tasks against the matrix
  numbers. (Briefly considered first: a Sonnet session running `/sonnet-sonnet` itself.)
  Evidence: replay matrices 1 and 2 ([[skill-trial-duo-vs-trio]]).
- PILOT 1 DONE 2026-10-17 (user: "a single task"): #226 MERGED #834 (ba51bf50c). Sonnet max driver passed round 1 and
  reported 2 verified items; the Opus review moved the consequential one into the PR (fix round 1, Sonnet medium
  fixer) and filed the minor one as #229; it found nothing new itself. Cost $8.99: agents $2.95, the Opus session
  $6.05 (53 requests at ~326k context each). Next pilot: compact the session first, since its context, not the
  agents, set the price. Recipe: `.claude/tmp/modularity/fnf226/drive.md` (worktree setup: build modules with
  `--filter '@haive/module-*'`; `./modules/*` matches nothing under `pnpm -C`).
- The open-work index stays in `.claude/tmp/track-b/b3/ledger.md` and [[found_not_fixed_running_list]].
