---
name: step-cli-switch-is-user-global
description: 'Since #373 (2026-10-01) the step CLI switch writes a per-task choice; only the "Also for my later tasks" opt-in rewrites the user-wide preference, so snapshot and restore only around a check that ticks it'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 4a63120c-9dc0-4fa4-9b6c-fc8a25973f1c
  modified: 2026-10-01T07:28:52.528Z
---

Until #373 (merged 2026-10-01, migration 0169), `PATCH /tasks/:id/steps/:stepId/cli-provider`
looked per-task but upserted `user_step_cli_preferences` (role `default`) or
`user_step_cli_role_preferences` (named roles such as 01-plan-build's `expand`), keyed (user, step,
role) with no task, so every later task of that user inherited the pick. Since #373 it writes
`task_step_cli_choices` (task, step, role), which every resolver reads first and which goes with the
task. The user-wide tables change only when the request carries `remember: true`, the picker's
"Also for my later tasks" box. 09_6's "CLI for the fix" writes the task choice too.

**Why:** on 2026-09-24 the live10/live11 recovery checks used the route and left the user's
`01-plan-build` default pointing at gemma4 cloud, noticed only by chance an hour later and restored
from task events and invocation records. That is the leak #373 closed. It still applies to any dev
stack not yet synced past `54928137`, and to a check that ticks the box.

**How to apply:**

- A live check that switches a step's CLI without the box needs no snapshot: the choice row is the
  task's own and cascades away with a deleted fixture task.
- A check that ticks "Also for my later tasks" (or sends `remember: true`) rewrites the user-wide
  row exactly as before: SELECT the rows for that step first and restore them afterwards with an
  UPDATE or DELETE guarded on the value you wrote.
- To pin a named seat mid-run without the route, insert a `task_step_cli_choices` row for that
  (task, step, role); `task_step_cli_touched` is no longer written and is read only for tasks that
  predate the choices.
- The api refuses the switch while the step is `running`/`waiting_cli`, and on a `failed` step at
  iteration 0 it resets the step (deleting its mining rows). The "swap CLI, then Resume" flow only
  works from `done`, or from `failed` past iteration 0.

Related: [[recovery-context-followups-series]], [[own-post-step-verification]],
[[found-not-fixed-sweep-3-series]].
