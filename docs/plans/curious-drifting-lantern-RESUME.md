# Resume note — DAG verification run

Paused 2026-08-21 ~21:35Z (storm / power). Global pause is ON
(`config:orchestrator:globalPause` = true). Nothing will be picked up until it is
turned off.

## To resume

1. Check the stack is up: `docker compose ps` — if power dropped, `pnpm docker:dev`.
2. Unpause: admin UI, or
   `PUT /admin/config/global-pause {"paused": false}`.
3. Check the in-flight invocation from before the pause resumed rather than orphaned:
   the `05` step should move off `iteration_count` or its queued invocation should get a
   `started_at`. If it sits unchanged for minutes, use **resume** (NOT retry — retry
   resets a loop step to pass 0 and throws away the completed passes; resume re-dispatches
   only the failed pass).

## Where the DAG run stopped

Task `de2b313d-43cf-4976-b74f-f1b9835f8074` — "Harden the admin dashboard",
repo `rs_glm_53_max`, claude-code Opus 4.6 Low (subscription), path `full_workflow`.

Stopped at `05-phase-0b5-spec-quality`, ~iteration 5-6. It failed once at 21:28 on a
TRANSIENT api_error ("Connection lost mid-response") and was recovered with resume
(`resumedFromIteration: 5`) — that is not an open problem.

Still ahead, in order: `05a` -> Gate 1 (writes `.haive/spec.md`) -> `06-run-config`
(PICK MCP MODE for 08a if offered — the 08a ledger writes live in `applyMcp`) ->
`06b` (THE DAG DECISION) -> implementation -> 08a/08d -> gates 2/3/4.

## What this run still has to prove

- **DAG** — `06b` must plan a DAG. Not forceable; `06-run-config` only offers
  `proceed` / `use_single_agent`. The brief was written against the planner's stated DAG
  criteria (four independent areas, four acceptance criteria spanning different concerns).
  If it picks single again, that is a finding in itself, not a retry-until-it-works.
- **F3** — `08a` / `08d` ledger writes, currently unit-tested only. `full_workflow` is
  the only path that materializes them (`plan_tasklist` 0/96 tasks, `quick_bugfix` 0/80).
- **F6 end-to-end** — gate 4 with a live worktree and no origin. Could not be reproduced
  on the completed task 153a3437 because step 12 removed its worktree, so `form()` took
  the no-git branch instead.
- **F1 (post-cap)** — already partly proven this run: `04-phase-0b-pre-planning` landed a
  284-char `summary` ledger entry where it was absent entirely before.

## Other live task

`153a3437-...` is `waiting_user` on `12-worktree-cleanup` — that is the FIRST verification
task, already completed once and then reopened by a gate-4 retry. It has no outstanding
work; it can be left parked or its cleanup form re-submitted (`action: merge_remove`,
`deleteBranch: true`). Its merge already landed (`346cd65`) and its worktree is gone.

## Fixes landed today (all pushed? CHECK — see below)

- `d5162d5` fix(forms): hidden field no longer fails the submission that hides it (F6)
- `6e72b08` feat(worker): every agent step has a route into the task ledger (F1, F4)
- `d73bb55` fix(worker): duplicate advance no longer re-runs a finished step (F2)
- `33b57af` fix(worker): cap a curated summary before it enters the ledger (F1 regression,
  caught live — discovery's "summary" is its whole 18k findings document)

These were committed locally. Confirm with `git log --oneline origin/main..HEAD` whether
they still need pushing.

## Open, not fixed

- **F2 remains half-open**: the duplicate advance-step job is still ENQUEUED, merely
  harmless now. Prime suspect is the pause/resume path (0.63s gap is far too fast for a
  BullMQ stalled re-delivery). See the F2 section of `curious-drifting-lantern.md`.
