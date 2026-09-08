-- Loop iteration support for steps whose StepDefinition declares a `loop`
-- hook. The runner re-spawns the LLM phase up to N times, calling
-- shouldContinue(applyOutput) between passes to decide whether another
-- iteration is warranted (e.g. spec-quality review iterating until no
-- error/warn findings remain).
--
-- cli_invocations.consumed_at: marks when the runner has incorporated this
-- invocation's output into an apply pass. resolveLlmPhase queries the
-- latest non-superseded, non-consumed invocation; when none exists it
-- enqueues a fresh one. Consumed invocations stay visible in the inline
-- per-step terminal so the user can scroll through every loop pass.
ALTER TABLE "cli_invocations" ADD COLUMN "consumed_at" timestamp;

-- task_steps.iterations: append-only array of per-pass results. Each entry
-- captures the LLM output, the apply output, and whether shouldContinue
-- was still true after that pass. The final pass also writes its apply
-- output to task_steps.output as before for downstream loadPreviousStepOutput.
ALTER TABLE "task_steps"
  ADD COLUMN "iterations" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- task_steps.iteration_count: integer mirror of jsonb_array_length(iterations)
-- kept on the row so step-runner can branch on it without a JSONB scan.
ALTER TABLE "task_steps"
  ADD COLUMN "iteration_count" integer NOT NULL DEFAULT 0;

-- tasks.step_loop_limits: per-task override map { stepId: maxIterations }.
-- Lets the new-task form pick how many loop passes a step is allowed
-- (e.g. spec-quality 3 vs 10). Falls back to loopSpec.maxIterations when
-- the step id is absent.
ALTER TABLE "tasks"
  ADD COLUMN "step_loop_limits" jsonb NOT NULL DEFAULT '{}'::jsonb;
