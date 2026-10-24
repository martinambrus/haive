---
name: plan-breadth-refusal-recheck
description: "Parked measurement: after the next real plan build + coverage run, check that breadth-cap refusals of coverage repairs have gone to ~0 now that the repair prompt tells the truth about the node's children"
metadata:
  node_type: memory
  type: project
  originSessionId: 30519ee1-6515-4c11-a33c-53e31117a3e4
  modified: 2026-09-20T08:17:40.012Z
---

Shipped 2026-09-19 in PR #177 (`b9085ad4`): a `02-plan-coverage` structural repair now reads its
node's live neighbourhood (`buildPlanExpansionContext`), is told how many direct children the node
already has and how much room is left under `breadthCap`, and quotes what the previous attempt
lost. Before that, every repair prompt said "it currently has no children" — MEASURED, to nodes
with 7-19 — and the plan it was shown was a head slice cut at 60,000 characters that contained the
node in 1 of 9 cases. 10 of 231 coverage agents were refused by the cap, and 5 of those replies
re-added exactly as many children as already existed.

**The outcome is UNMEASURED and needs real agents.** Run this after the next real plan build and
its coverage gate (any repo; the dev install had zero `plan_nodes` on 2026-09-20, so nothing could
be measured then):

```sql
-- Rows written AFTER the fix only. Without the date this counts the 10 pre-fix
-- refusals too, and a clean run reads as a failure.
select ts.step_id,
       count(*) filter (where m.error_message like '%breadth cap%') as refused,
       count(*) as agents
from task_step_agent_minings m join task_steps ts on ts.id = m.task_step_id
where ts.step_id in ('01-plan-build','10_8-plan-build','02-plan-coverage')
  and m.created_at > timestamp '2026-09-19 18:24'
group by 1 order by 1;
```

Expect `refused` at or near 0 for `02-plan-coverage`. The baseline it is measured against is 10
refused of 231 agents, all of them before that timestamp. A refusal that still happens is worth reading
in full — its prompt is `cli_invocations.prompt` for that agent's invocation — because the node's
child count and the room left are now IN that prompt, so a refusal means the agent ignored them
rather than never being told.

**Already verified deterministically on 2026-09-20, do NOT re-check these two:** a node with
children whose latest repair was refused is offered again at the gate and pre-ticked (with the
refusal quoted as its `detail`), and a repair replying with an empty patch leaves the row unstamped
and retires the gap. Both were driven through the real `detect`/`form`/`apply` on a throwaway plan.

Related: [[haive-worker-ui-check-without-llm]] for the zero-token fixture pattern.
