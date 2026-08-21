# Multi-model per step (fan-out + consolidator)

## Context

Today every step runs exactly one CLI/model. The user wants to attach an unlimited set of
models to any step so several CLIs work the same step in parallel and complement each other,
then a chosen "consolidator" model merges their drafts — keeping agreements, validating
additions, and resolving direct contradictions — into one contract-correct output. The set
must be settable at task creation (a task default) and editable per step (add/remove models),
mirroring today's per-step CLI change. The consolidator is picked separately, with a reasoning
selector when the provider exposes one. Auto-continue and the CLI lock must keep working.

Why it fits: the expensive infrastructure already exists and ships in production.
`agent_mining` already fans out N invocations per step, parks the step on a wait-for-all
barrier, and hands an array to `apply`; `StepTerminal` already renders N stacked terminals per
step; streaming and steering are already keyed per `invocationId`; the orchestrator guard
(`handleAdvanceStep`) already tolerates N concurrent invocations at one step. What is missing is
(a) storage for a *set* of providers (everything today stores one), (b) a worker phase that
fans out the same prompt across the set and runs a consolidator, and (c) the consolidator
prompt/validation semantics. This plan reuses the mining fan-out/barrier pattern rather than
inventing new orchestration.

Key reused facts (verified in code):
- `resolveLlmPhase` (`packages/worker/src/step-engine/step-runner.ts:370`) single-dispatches one
  invocation via `.limit(1)` readback (line 397) → one `llmOutput` into `apply` (line 1417).
- `resolveAgentMiningPhase` (step-runner.ts:773) is the fan-out+barrier template: read all
  child rows, re-park `waiting_cli` while any pending, else return an array. `dispatchMiningAgents`
  (863) pins ONE provider (873) — the only thing stopping per-provider variance.
- `apply` already accepts arrays (`agentMiningResults`) and the `MiningWaveError` pattern
  (step-definition.ts:270, handled step-runner.ts:1432) already does "park → dispatch a dependent
  wave → re-apply with the full set" — the shape a consolidator needs.
- `tasks.stepLoopLimits` / `preAnswers` (schema `packages/database/src/schema/tasks.ts:196,213`)
  are the precedent for per-task, per-step JSONB config maps — where the model-set belongs.
- `CliProviderMetadata.effortScale` (`packages/shared/src/cli-providers/catalog.ts:40`) already
  drives "show a reasoning dropdown iff the provider has one"; the web `effortSelectFor` helper
  (`packages/web/src/app/(app)/tasks/[id]/page.tsx:2423`) already renders it conditionally.

Decisions (sensible defaults; flag if you disagree):
- Model-set is TASK-SCOPED JSONB (`tasks.model_sets`), seeded at creation, overridable per step —
  NOT persisted per-user across tasks. Simpler, atomic, matches `stepLoopLimits`. (Per-user
  persistence can be added later if wanted.)
- Multi-model engages only when a step's resolved member set has >= 2 providers AND a consolidator
  is set. 0/1 members → today's single path, byte-for-byte unchanged.
- A failed member degrades (consolidator runs with the survivors); the step fails only if every
  member failed. No per-member retry in Phase 1.
- The retry/robustness seam re-rolls the CONSOLIDATOR (one cheap invocation), not the members.

Rollback (write-before-change): the entire feature is three additive, nullable/defaulted columns
plus new code paths gated on "is a set configured". Rollback = drop the three columns and the set
config is inert; every step falls back to the single path. No enum changes, no data migration,
no destructive step.

---

## Data model (shared + database)

New shared types in `packages/shared/src/cli-providers/` (or alongside the task schemas):
```ts
interface ModelRef { cliProviderId: string; effortLevel: string | null; }
interface StepModelSet { members: ModelRef[]; consolidator: ModelRef | null; }
// stored on the task:
type TaskModelSets = { default?: StepModelSet; steps?: Record<string /*stepId*/, StepModelSet>; };
```

Migration (additive only — `packages/database/src/schema/tasks.ts`, then `drizzle-kit push --force`
+ a numbered idempotent `.sql` per the repo convention):
- `tasks.model_sets jsonb NOT NULL DEFAULT '{}'::jsonb` (`$type<TaskModelSets>()`).
- `cli_invocations.model_set_role text` — null | `'member'` | `'consolidator'`. Discriminates the
  fan-out rows from a plain single invocation. Chosen over adding `cli_invocation_mode` enum values
  because dropping an enum value is not cleanly reversible; a nullable text column drops trivially.
- `cli_invocations.model_set_group text` — null for plain multi-model (the group is the step); the
  owning `agentId` / dag `issueKey` in Phase 2. Lets the phase reconstruct all state from
  `cli_invocations` alone — no new join table.

Zod: extend `createTaskRequestSchema` (`packages/shared/src/schemas/tasks.ts:64`) with an optional
`defaultModelSet: StepModelSet`. Add `setStepModelSetRequestSchema = { members: ModelRef[];
consolidator: ModelRef | null }` (new, sibling of `setCliProviderRequestSchema:164`). Validate
each `effortLevel` against the provider's `effortScale` server-side (reuse the existing
`clampEffort` logic in `packages/api/src/routes/tasks/steps.ts:38`); require a consolidator when
`members.length >= 2`.

---

## Phase 1 — single-LLM steps (the core; fits the concurrency cap)

Scope: steps that declare `stepDef.llm` and NOT `loop` / `agentMining` / `dagExecute` /
`mergeResolve`. This is the majority of steps and keeps the recursive `resolveLlmPhase` callers
(loop re-enter, mining) out of the multi-model path.

### 1a. Resolver — `resolveModelSet(...)`
New helper beside `resolvePreferredCli` (step-runner.ts:117). Reads `tasks.model_sets`, returns
`tasks.model_sets.steps[stepId] ?? tasks.model_sets.default ?? null`. Returns null when the set has
< 2 members (caller falls back to the single path). This is the multi-model analog of
`resolvePreferredCli` and honors the same task-default-vs-per-step precedence the lock relies on.

### 1b. Worker phase — `resolveMultiModelPhase(...)`
New function in step-runner.ts, same `LlmResolved` return shape as `resolveLlmPhase`
(`{resolved:true, llmOutput, current}` | `{resolved:false, result}`), so it is a drop-in at BOTH
LLM call sites: pre-form (step-runner.ts:1129) and post-form (1345). Route via a thin wrapper
`resolveLlmOrModelSetPhase(...)`: if `resolveModelSet` returns a set → `resolveMultiModelPhase`,
else → existing `resolveLlmPhase` (unchanged). Modeled directly on `resolveAgentMiningPhase`:

1. Read this step's fan-out rows: `cli_invocations WHERE taskStepId AND model_set_group IS NULL AND
   supersededAt IS NULL AND model_set_role IN ('member','consolidator')`.
2. No rows yet → fan out one MEMBER invocation per `ModelRef`: build the prompt ONCE with the step's
   own `llm.buildPrompt` (identical to the single path, so member output is contract-shaped), then
   for each member `resolveDispatch({ preferredProviderId: member.cliProviderId, ... })`, insert a
   `cli_invocations` row (`model_set_role:'member'`, `agentTitle` = provider label, `cliProviderId`,
   effort from the ref), `enqueueCliInvocation` (`kind:'cli'`). Park `waiting_cli`. (This is
   `dispatchMiningAgents` with the provider varied per iteration instead of pinned.)
3. Members still running → `waiting_cli` (barrier).
4. All members ended, consolidator not yet dispatched → dispatch the CONSOLIDATOR: one
   `cli_invocations` row (`model_set_role:'consolidator'`, `agentTitle` = "Consolidator (<model>)"),
   prompt = `buildConsolidatorPrompt(originalPrompt, memberDrafts)`. Park `waiting_cli`.
5. Consolidator ended OK → `llmOutput = consolidator.parsedOutput ?? rawOutput`, resolved. Its output
   flows into the step's normal `parseOutput`/`apply` unchanged.
6. All members failed → fail the step (like `resolveLlmPhase`'s failed-invocation arm, 465). Some
   failed → consolidator prompt notes which models are absent and proceeds with survivors.

`buildConsolidatorPrompt(original, drafts)` — one generic function (new, e.g.
`packages/worker/src/step-engine/consolidator.ts`), NOT per-step. Shape: embed the step's own
original prompt (so the required output format/contract is stated verbatim), then the N drafts
labeled by model, then the reconciliation rules: keep agreements; for anything ONE model added,
validate before including; for DIRECT contradictions, decide which is correct and why; emit the
final answer in the exact format specified above, plus a short `<<CONSOLIDATION_REPORT>>` block
(agreements / validated-additions / resolved-contradictions). Persist that report on the
consolidator invocation for display (it rides in `rawOutput`; the step's `parseOutput` already
ignores trailing prose, or strip it before parse).

### 1c. Retry seam
The apply-throw retry block (step-runner.ts:1521) currently calls `markLatestInvocationConsumed` +
`resolveLlmPhase`. For a multi-model step, add a branch that instead marks the CONSOLIDATOR row
consumed (`markConsolidatorConsumed`, a scoped variant) and re-enters `resolveMultiModelPhase`,
which re-dispatches only the consolidator (members stay done). Bounded by `llm.retry.maxAttempts`
counted over consolidator rows. Members are never re-rolled in Phase 1.

### 1d. API
- Creation (`packages/api/src/routes/tasks/index.ts:~230`): persist `body.defaultModelSet` into
  `tasks.model_sets.default`.
- New route `PATCH /tasks/:id/steps/:stepId/model-set` (sibling of the `cli-provider` handler,
  `packages/api/src/routes/tasks/steps.ts:765`): validate, write `tasks.model_sets.steps[stepId]`,
  invalidate + re-enqueue advance like the existing handler (steps.ts:957). Empty members clears the
  step override (falls back to default/single).
- Surface it: extend `enrichStepsWithCliPreferences`
  (`packages/api/src/routes/tasks/_helpers.ts:85`) to attach `modelSet: StepModelSet | null`
  (resolved step-override-or-default) so the UI can render the current set per step.

### 1e. Web
- New-task form (`packages/web/src/app/(app)/tasks/new/page.tsx`, near the CLI select at 549-604):
  add a "Complementary models" builder — an add-a-row list of provider dropdowns (unlimited) + a
  "Consolidator" section (provider dropdown + `effortSelectFor`-style reasoning selector that
  appears only when the chosen provider has an `effortScale`). When >= 2 members are chosen this
  becomes `defaultModelSet`. The existing single CLI select + lock stays as the fallback/legacy path;
  the default set, when present, is the "one lock over the combination" the user described (it
  applies to every step unless a step overrides it).
- Per-step card (`packages/web/src/app/(app)/tasks/[id]/page.tsx`, the CLI picker block at 2401-2446):
  add an expandable "Models" control rendering `step.modelSet` — the same members+consolidator
  builder — posting to the new model-set endpoint via a `changeStepModelSet` handler (sibling of
  `changeStepProvider:853`). Reuse `effortSelectFor` (2423) for each reasoning selector. Gate on the
  same `cliLocked`/`cliBusy` states.
- StepTerminal: NO change. It already lists all non-superseded invocations for the step and labels
  them by `agentTitle` + a run index; members show as "Claude Opus", "Codex", … and the consolidator
  as "Consolidator (…)". Setting `agentTitle` in 1b is all that is needed.

Auto-continue: NO change. It gates forms only (step-runner.ts:1166-1299), never `waiting_cli`; the
member/consolidator barrier parks and resumes on its own exactly like mining.

---

## Phase 2 — multi-terminal steps (loop, mining, DAG)

Same primitive (fan-out members → consolidate), applied to steps that already fan out. Higher cost
(N members x M existing terminals) and, for mining/DAG, a nested barrier. Order by rising
difficulty; each sub-scope is independently shippable.

### 2a. Loop steps (easiest — per-iteration set)
Loop iterations are sequential, so each iteration just runs a model-set whose consolidator output
becomes that iteration's `llmOutput`, then `shouldContinue` decides the next. The loop re-enter at
step-runner.ts:1614 routes through `resolveLlmOrModelSetPhase` instead of `resolveLlmPhase`;
`markLatestInvocationConsumed` (1589) becomes "consume this iteration's consolidator + members".
`resolveRole(iteration)` still selects which stored set to use if roles carry distinct sets.
Moderate; no nesting.

### 2b. Agent-mining steps (nested barrier)
Each mining agent becomes a group: `model_set_group = agentId`, its M members + consolidator tagged
as in Phase 1. `dispatchMiningAgents` (step-runner.ts:863) stops pinning one provider and instead,
per agent, fans out the set. `resolveAgentMiningPhase`'s barrier (773) gains a sub-level: an agent's
`task_step_agent_minings` row stays `pending` until its group's members+consolidator finish, at
which point the consolidator output is written as that agent's result; the outer "all agents done"
barrier then proceeds unchanged. This is the genuinely complex, N x M-cost piece — spec it, gate it
behind the per-task concurrency cap (`MAX_PARALLEL_AGENTS_PER_TASK`), and `log` any deferral so the
throttle is visible.

### 2c. DAG coder steps (nested barrier + worktrees)
Same nesting as 2b applied to the DAG coder fan-out (`dag-executor.ts` coder loop ~1378), where each
coder writes files in its own worktree. Highest cost and complexity; recommend shipping last (or
deferring) — a consolidator reconciling N code-writing drafts also has to reconcile file edits, not
just text. Flag explicitly as optional.

---

## Cost & caveats to surface in the UI/docs
- A multi-model step costs ~ (members + 1) invocations/tokens/sandboxes. Per-task cap is 5
  (`MAX_PARALLEL_AGENTS_PER_TASK`), global 3 — large sets self-throttle (`enforceTaskAgentCap`
  defers), lengthening wall-clock. Phase-2 N x M can hit the cap hard; keep it opt-in per step.
- The consolidator concatenates N drafts — for large-output steps (full spec, code review) this can
  strain context. Members self-selected per step by the user, who owns the tradeoff; pick a
  large-context consolidator. No auto-summarization in v1 (note the limit).
- Consolidator contradiction-validation is best-effort model judgement, NOT a correctness guarantee.
  It is a structured reconciliation prompt + report, not determinism. Set expectations in the UI.

---

## Verification
- Unit (Vitest, worker): drive `resolveMultiModelPhase` through fan-out → barrier → consolidate →
  resolved, asserting one member row per `ModelRef`, a single consolidator, correct `waiting_cli`
  parks, and that `llmOutput` == the consolidator output. Add a "one member fails, consolidator runs
  with survivor" case and an "all members fail → step fails" case. Reuse the mining phase tests as a
  template.
- Regression: a step with 0/1 configured members takes the untouched `resolveLlmPhase` path — assert
  byte-identical behavior (no member/consolidator rows written).
- End-to-end (dev stack, per the repo ops memory — rebuild shared+database, restart worker): create a
  task, attach 2 providers + a consolidator to one plain-LLM step, run it, and confirm in the task UI
  that StepTerminal shows N member terminals + a consolidator terminal, the step completes, and
  `apply` consumed the consolidator output. Verify auto-continue still auto-advances forms and the
  default-set "lock" applies to every step until a per-step override is set.
- Migration: `drizzle-kit push --force` on a clean DB, confirm the three columns exist and default
  correctly; confirm dropping them (rollback) leaves the single path working.

---

# Amendment — 2026-08-21: status, re-verified anchors, sequencing, and an evidence bar

**Status: none of this is built.** `grep -r 'model_set|modelSet|ModelSet' packages/` returns zero
hits — no columns, no shared types, no route, no UI. `consolidator` in code hits only unrelated
strings (a sort comment in `08d-adversarial-qa.ts:394`, an onboarding hint). No feature branch
exists; the plan has a single commit (`083a003`, the bulk plan archive).

## Every line anchor in the body above has drifted

The body was written against a ~1600-line `step-runner.ts` that is now 3269 lines. Re-verified
2026-08-21; the body is left byte-identical per the plan-archive convention, so read the anchors
through this table and grep the symbol rather than trusting either column later.

| Body says | Actually (2026-08-21) |
|---|---|
| `resolvePreferredCli` step-runner.ts:117 | 145 |
| `resolveLlmPhase` :370, `.limit(1)` readback :397 | 436, readback 475 |
| failed-invocation arm :465 | 479 |
| LLM call sites pre-form :1129 / post-form :1345 | 1571 / 1787 (inside `advanceStep`, 1438) |
| `resolveAgentMiningPhase` :773 | 972 |
| `dispatchMiningAgents` :863, pins one provider :873 | 1236, pin at 1246 |
| `MiningWaveError` step-definition.ts:270, handled :1432 | 312, handled 1887 |
| apply-throw retry block :1521 | 1974 |
| loop re-enter :1614, `markLatestInvocationConsumed` :1589 | 2060, 2035 |
| auto-continue form gate :1166-1299 | 1606-1639 |
| `tasks.stepLoopLimits` / `preAnswers` schema :196,213 | 294, 311 |
| `CliProviderMetadata.effortScale` catalog.ts:40 | 54 |
| `createTaskRequestSchema` :64, `setCliProviderRequestSchema` :164 | 65, 205 |
| `clampEffort` steps.ts:38, cli-provider handler :765 | 65, 1125 |
| `enrichStepsWithCliPreferences` _helpers.ts:85 | 85 (unchanged) |
| web `changeStepProvider` :853, `effortSelectFor` :2423 | 1069, 2720 |
| task creation persist `index.ts:~230` | 313 (`createTaskRequestSchema.parse`), provider write 352 |
| dag coder loop `dag-executor.ts:~1378` | per-level coder dispatch around 643 |

## Approach B already ships, and the cheapest win lives inside it

The plan frames this as "fan out across models, then consolidate" (call it **A**). The alternative
it never names is **B**: one main CLI drives the step, other CLIs check and complement it. B is not
hypothetical here — Haive already implements it three ways:

- **Different model per step**: `user_step_cli_preferences` (`packages/database/src/schema/cli-providers.ts:224`).
- **Different model per ROLE inside a loop step**: `user_step_cli_role_preferences` (same file, 253),
  resolved at `step-runner.ts:672` through `stepDef.loop.resolveRole`. Spec-quality's reviewer and
  corrector can already be two different CLIs.
- **Driver plus independent critics with an evidence bar**: 07 implements; `08c-code-review.ts` runs
  peer and security reviewers in parallel via mining, then a second `MiningWaveError` wave of
  refuters (three lenses, unanimity, fail-closed); `08d-adversarial-qa.ts` runs N adversaries that
  must produce a non-destructive PoC before a finding counts.

What is missing from B is exactly one line of variance: `dispatchMiningAgents` calls
`resolvePreferredCli` ONCE and pins that provider for the whole fan-out, so every mining agent today
is the same model wearing a different persona. Note also that when 08c needed diverse voters it
bought diversity with prompt lenses rather than models (`08c-code-review.ts:319`) — a deliberate
house choice, not an oversight.

## What each shape optimises — decide per step KIND, not once for the product

| | A: fan-out + consolidate | B: driver + critics |
|---|---|---|
| Optimises | recall — the union of what N models see | precision — killing a wrong claim |
| Failure it fixes | one model missed a thing | one model asserted a wrong thing |
| Failure it ADDS | unique-but-false additions get merged in | nobody looks where nobody was told to look |
| Merge unit | prose or JSON drafts | a verdict plus cited evidence |
| Marginal cost | (members + 1) new invocations | +0 on a fan-out that already exists |

Both directions are evidenced by `benchmarks/README.md` (66 runs, 19 models):

- **For A**: `grok-4.6` produced four findings appearing in no other run of 66; Opus 5 max alone
  found the search stub; `muse-xhigh` alone found the inverted `in_array` guard. Models genuinely
  see disjoint things.
- **Against naive A**: two "only run in N" uniqueness claims inherited from the 8 August edition
  were checked before reuse and both were wrong; `muse-high` emitted four citations naming a real
  file and an in-range line belonging to a different function, "a defect no automated checker in
  this benchmark can see"; `glm53-max` described its own sandbox by-products as project structure.
  Unique does not mean true, and a consolidator reading only drafts cannot tell the two apart.

## Sequencing

1. **First, and cheapest by a wide margin: unpin the provider in the fan-out.** Give
   `dispatchMiningAgents` a per-dispatch provider instead of one resolved for the whole set. Then
   08c's peer reviewer runs on a different model from 07's implementer, and 08d's adversaries spread
   across models. Zero extra invocations — those agents already run — and no new columns, no
   barrier, no consolidator. This delivers the "different CLIs check each other" property on its own
   and should land before Phase 1 is started.
2. **Then Phase 1 (A), but ONLY for divergent, generative steps**: 03 discovery, 03b business
   requirements, 04 pre-planning, 05 spec quality, `deep_scan`, KB mining. There the product IS a
   union of observations, a missed requirement costs a whole re-run, and a wrong addition is cheap
   because a human reads it at gate 1. Union-merge is the right primitive there.
3. **Never A for verdict or code steps**: 08c, 08d, the gates, 07, 12. Consolidating N verdicts
   averages away the one model that was right, and consolidating N code drafts means reconciling
   file edits rather than text — Phase 2c already concedes this. B covers these correctly today.
4. **Nothing for deterministic steps** (01 worktree, 06a db-migrate, env-replicate). No ground truth
   to triangulate, pure cost.

This makes Phase 2b optional rather than the goal: `kind-riding-dream.md` already declares it
optional, and under this sequencing 2c should be dropped rather than deferred.

## The consolidator needs the refuter's evidence bar

Phase 1b says that for anything ONE model added, the consolidator should "validate before
including". That is precisely the operation the benchmark shows failing — the wrong-function
citations were invisible to every checker in the round, and two inherited uniqueness claims were
simply false. A consolidator that reasons over drafts alone will promote one model's hallucination
into the merged answer, which is worse than not running A at all.

So `buildConsolidatorPrompt` must give the consolidator repo access and hold unique additions to
08c's refuter bar: an addition present in only one draft survives only with a cited `file:line` that
supports it; otherwise it is dropped, or demoted into the `<<CONSOLIDATION_REPORT>>` as advisory.
Agreements across two or more drafts keep the cheap path. This raises the consolidator from a
prose-merging call to a real tool-using sandbox invocation — cost it accordingly, and keep the
existing caveat that reconciliation remains best-effort judgement.

## Cost reality on the reference dev host

`MAX_PARALLEL_AGENTS_PER_TASK` defaults to 5 (`config.service.ts:454`) but the real ceiling is the
measured agent pool, floored at `DEFAULT_AGENT_FLOOR` 2 (`host-resources.ts:157`) with
`agentWeightMb` 2048. On the WSL2 dev host the pool sits near that floor, so a 3-member step plus a
consolidator is 4 invocations drained two at a time — roughly triple the wall clock for that step,
before the consolidator's own tool use. Step 1 of the sequencing costs nothing extra. That gap is
the whole argument for the ordering.

## Measure before building Phase 1

Nobody has yet measured whether a consolidator of N drafts beats the best single draft under the
benchmark's own scoring; the uniqueness evidence is per-run anecdote. The drafts already exist —
take three scored runs of one task, merge them by hand under the rules in 1b plus the evidence bar
above, and score the merge. If the merge does not beat the best single run, Phase 1 is not worth its
multiplier and step 1 of the sequencing is the entire feature.
