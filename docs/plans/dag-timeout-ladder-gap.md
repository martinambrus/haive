# DAG executor cannot climb the timeout ladder

> Status: IMPLEMENTED 2026-08-24, during the benchmark's pause window.
>
> Shipped as written: `overrideOrLearned` (explicit override > learned > declared) reads the
> same `cli_timeout_learned_ms` the step-runner maintains, and `escalatedTimeoutMs` doubles it
> under the existing `LEARNED_TIMEOUT_MAX_MS` clamp. Two things worth recording:
>
> - **The escalation is written to the STEP, not the issue.** Every coder in a level shares one
>   budget, so the fan-out's wall-clock ceiling stays computable (N x escalated, bounded to two
>   doublings by `DAG_MAX_INFRA_RETRIES`). A per-issue ladder would have made it unknowable —
>   which is the reason `overrideOr`'s comment gave for having no ladder at all, and that reason
>   still stands for the per-agent case.
> - **The write is guarded `isNull OR lt`,** so a level whose coders time out one after another
>   raises the budget once per rung rather than once per coder.
>
> Only a timeout-classified failure escalates (`isCliTimeoutFailure`), and an unparseable budget
> yields null rather than an invented number.

## The gap

`dag-executor.ts` resolves every CLI budget through `overrideOr(step, declaredMs)`
(`dispatch-timeout.ts:24`):

```ts
const override = step.cliTimeoutOverrideMs;
return override && override > 0 ? override : declaredMs;
```

That is a FLAT lookup. It never reads `task_steps.cli_timeout_learned_ms`.

The step-runner path does ladder properly: it reads the learned value (`step-runner.ts:3135`),
writes it back one rung larger after a timeout (`:3197`), and the clamp
`LEARNED_TIMEOUT_MAX_MS` (8h) stops it walking away.

## Why it matters

A DAG coder killed by its budget is re-dispatched **at the same budget**, dies again, and repeats
until `DAG_MAX_INFRA_RETRIES` is spent — then the issue is abandoned. The one executor that runs
the longest single invocations is the one that cannot ask for more time.

MEASURED: task `3921a515` (codex high) lost a `06c-dag-execute` coder at 1892s against the 30m
default. The DAG correctly kept the 3 finished issues (`completed_with_debt`) and returned the
dead one to `pending` — but it would have re-run it at 30m indefinitely. A manual
`cli_timeout_override_ms = 90m` is what broke the loop.

## Approach

Make the DAG read the same learned value the step-runner maintains, rather than duplicating the
ladder. Likely shape: `overrideOr` gains a learned-aware sibling (or takes the learned column
into account) so precedence becomes **explicit override > learned > declared**, and the DAG's
timeout-classified failures write the next rung back the way `step-runner.ts:3197` does.

Keep the explicit override winning: a human pin must not be overwritten by a learned value.

## Verification

- A DAG issue that times out is re-dispatched at a LARGER budget than the one that killed it.
- A step with an explicit `cli_timeout_override_ms` keeps that value regardless of learned.
- The learned value still clamps at `LEARNED_TIMEOUT_MAX_MS`.
- A DAG issue that fails for a NON-timeout reason does not inflate the budget.
