# T681 insight loop + DPA P2 (shared insight loader)

> Status: approved 2026-11-15. PR1 (the shared insight loader) is this change; PR2-PR5 follow.

## Context

What exists today:
- Review steps and implementation append an optional `## INSIGHTS` block (`INSIGHTS_INSTRUCTION`, `packages/shared/src/step/prompts.ts`).
- `08e-insights-triage` collects up to 30 of these and offers them as an unchecked multi-select; one writer invocation applies the picks.
- Gate 2 shows unacted insights as information only.
- Gate 3 shows them as follow-up text, and only when gate 2 has no output.

Your decisions (2026-11-14):
- The opt-in switch lives in `06-run-config` and is OFF by default.
- **OFF:** no triage agent runs, and every insight is a checkbox at 08e and at gate 3.
- **ON:** a separate triage agent auto-applies the consequential items, then 08 verify and 08c review run again, for up to 3 rounds. Nits are only listed.
- **Gate-3 picks:** apply, then 08, then 08c, then back to gate 3. Gate 2 is asked again only if verify fails.
- **End summary:** every insight with its class and outcome.
- **DPA decision 5:** one shared loader (DPA P2), so there is no second parser and no positional ids. It lands first.

Design source: `/home/zathrus/haive/.claude/tmp/codex-run/INS-S/codex-1/design.md`, a Codex analysis at eca320f01 with line-numbered evidence beside it. I reviewed it and corrected two of its premises; both are in PR2 below.

## Two points to confirm (both are in PR2)

1. **Storage: on a `tasks` column, not in step output.**
   - The design wanted the switch only in the 06 output. A manual step reset nulls `task_steps.output`, so after a Retry the switch would silently read OFF.
   - So it goes on `tasks.auto_act_on_insights` (boolean, NOT NULL, default false), written by 06 apply as `simplifyCode` is.
   - This needs one small additive migration.
2. **Remembering: only this switch.**
   - The board says the switch is carried "like the other run-config fields". It cannot be: 06 has NO prior-task reuse today (`06-run-config.ts` sets neither `reuseLastCompletedFormValues` nor a reconcile hook). Its defaults come from task columns, presets and the AI recommendation.
   - Recommendation: remember ONLY this switch. Its default comes from your last completed task on the same repo and type.
   - Not recommended: turning on reuse for the whole 06 form. That would also start remembering QA depth, browser options, caps and dimensions.

## Approach (five PRs, smallest first, each reviewed at xhigh)

### PR1: DPA P2, one insight loader

- Move the parser and source loader into a new worker `_insight-loader.ts`. 08e and `_gate-insights.ts` keep re-exports; `_gate-insights.ts` becomes formatting only.
- `loadUnactedInsights(db, taskId, { limit?, includePicked? })`:
  - no limit means unlimited, and picked items are filtered BEFORE the limit;
  - `omitted` counts only the eligible items that were cut;
  - fields stay complete, and only the gate formatter clips them to 200 characters.
- Two identities:
  - the legacy title+location key, for selection counts;
  - `findingIdentity` (tolerates shifted line numbers), for matching across rounds.
- Records gain additive `sourceRefs`: the invocation, step and round, or the DAG-withheld issue and its severity.
- A task-bound host service `ctx.host.loadUnactedInsights`, following `worker/src/step-engine/step-host-services.ts` (owner, step and round binding, cancellation).

### PR2: the switch and the manual OFF forms (ON stays inert)

- Add the `autoActOnInsights` checkbox to 06. Its storage and remembered default are as described in the points above. An explicit preset or answer wins, and an absent value reads false.
- Migration: guarded and idempotent, column appended LAST, with Drizzle parity.
- Parked 06 forms get an idempotent schema-upgrade adapter, applied on API display, at submit validation and in the worker.
- 06 stops writing the synthetic empty 08e pre-answer, so an OFF 08e form now parks even under auto-continue.
- The checkbox stays hidden until PR4 enables execution.

### PR3: durable batch journal and revise continuation (manual 08e first)

- The 08e writer becomes an `agentMining` implementer seat with a strict per-id outcome report.
- 08e routes `reviseLoop -> 08`. A versioned continuation is stored in the routing verdict and in `task_events`; no new table.
- It composes with the existing editor revalidation (`queues/validation-recheck.ts`): 07c and 07b re-run first when the change moved, then 08, 08c and the configured tail.
- Insight rounds never write `fix_loop.started` and never consume the fix cap.
- Recovery follows worker-restarts.md: done-row replay, epoch and owner fences.
- A partial edit is recorded as unconfirmed, and the editor is never rerolled automatically.
- quick_bugfix and plan_tasklist gain reachable 08c and 08e steps. These skip unless a continuation is active.

### PR4: ON mode

- **Triage seat.** It classifies each new identity as consequential, minor or nit, with a kind. The host forces security, data loss and regression to consequential.
- **Never applied automatically:** third-party or infrastructure items, unknown ownership, and unsafe locations.
- **Strict output.** One entry per id and at most 2 attempts. An incomplete classification falls back to the manual form.
- **Round cap.** At most 3 automatic rounds per task, each claimed by an `insight.auto_round_started` event. Retry and Resume never reset the count.
- **After round 3.** Findings that appear later show as `unclassified`, with the outcome `cap_reached`.
- **Injectable budgets:** classifier input 32k characters, timeout 120 s.

### PR5: the gate-3 multi-select and the end summary

- Gate 3 always loads insights, as a multi-select with an empty default.
- A non-empty pick routes `reviseLoop -> 08e` BEFORE any staging or commit. Then 08 and 08c run, and gate 3 comes back with a regenerated diff and commit message.
- A failed 08 latches gate 2 until a new gate-2 approval.
- A deterministic `InsightSummary` (per item: class, outcome and attempt history) renders through `FormSchema` sections and `findingsSummary`.
- Docs to update: review-findings.md, task-types.md, modules.md (the fourth host service) and fix-loop.md.

## Rollback

- **PR1:** revert.
- **PR2:** revert the code. The column stays; it defaults to false and older code ignores it.
- **PR3 to PR5:** first stop creating new batches and opt-ins. Keep a capable worker running until every live v1 continuation settles. Spent rounds and the journal are never reset.

## Execution

- Codex driver at high effort, one worktree per PR. A Sonnet reviewer at xhigh reviews each PR.
- Each PR goes through bots and CI and merges only when the stack is idle.
- PR1 also closes DPA P2.

## Verification

Each PR's controls are taken from design section 8 and must fail on its parent first:
- **Loader:** returns more than 30, handles picked items across rounds, keeps identity when line numbers shift, counts omissions exactly.
- **Forms:** a remembered true and an explicit false; a parked 06 form accepts the new checkbox.
- **Loop:** crash, Retry, Stop and pause boundaries; no stale verify or review rows are reused.
- **ON mode:** zero triage dispatches when OFF; the downgrade of a security, data-loss or regression item is refused; no fourth round.
- **Gate 3:** a pick with commit=true stages nothing; a failed verify latches gate 2.

The full suite runs once, at the feature end. The capped real workflow run you already approved, near the end of the queue, exercises OFF mode live: the 08e checkboxes and the gate-3 picks.
