import type { schema } from '@haive/database';

/** The user's "Retry with longer timeout" value for this step, or the caller's own budget.
 *
 *  `task_steps.cli_timeout_override_ms` is written once, by the retry route, and read by
 *  every invocation the step goes on to dispatch. The step's own CLI already honors it
 *  through resolveDispatchTimeoutMs; this is for the agents a step FANS OUT — DAG coders,
 *  DAG reviewers, the replanner, the merge fix-agents — which passed a hardcoded constant
 *  and silently discarded the number the user chose. Setting a 90-minute budget and watching
 *  the run die at 30 is worse than having no control at all, because it looks like the
 *  control worked.
 *
 *  No ladder here on purpose: these sites already own bounded infra-retry budgets
 *  (DAG_MAX_INFRA_RETRIES, the merge fix cap), and stacking a second escalation on top would
 *  make the wall-clock ceiling of a level fan-out hard to reason about. The override is a
 *  deliberate act by a human; escalation is automatic, and only mining needed it.
 *
 *  A non-positive stored value is treated as absent — the API clamps writes to 15..480
 *  minutes, so 0/negative can only mean "cleared".
 *
 *  An undeclared budget stays undeclared when there is no override: the caller's `undefined`
 *  means "whatever the runner defaults to", and substituting a number here would change a
 *  site's behaviour as a side effect of adding override support. */
export function overrideOr(
  step: Pick<typeof schema.taskSteps.$inferSelect, 'cliTimeoutOverrideMs'>,
  declaredMs: number | undefined,
): number | undefined {
  const override = step.cliTimeoutOverrideMs;
  return override && override > 0 ? override : declaredMs;
}
