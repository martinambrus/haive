import type { TaskEvent } from '@/lib/api-client';

/** A steer restored from history. `status` is always `historical` — the live statuses
 *  (`sent`, `consumed`, `unconsumed`) belong to the session that sent them. */
export interface RestoredSteer {
  id: string;
  text: string;
  status: 'historical';
}

/** Which steers a terminal panel should replay.
 *
 *  Scoped to the INVOCATION, not just the step. A step can hold several invocations — a
 *  retry, or a multi-agent fan-out — and step-level scoping made every panel replay every
 *  panel's steers, misattributing what each agent was actually told.
 *
 *  A `steering.nudge` written before the id was recorded carries no `invocationId`, and
 *  those fall back to step-level matching: exactly right for a step with one run, and for a
 *  step with several it is the behaviour they already had. Dropping them instead would
 *  silently erase the history this restore exists to show.
 *
 *  Pure and separate from the component for the same reason `step-banners.ts` is: the rule
 *  is subtle, it has to be testable, and it must not be re-derived at a second call site. */
export function restoreSteers(
  events: readonly TaskEvent[] | undefined,
  stepRowId: string | undefined,
  invocationId: string,
): RestoredSteer[] {
  if (!stepRowId) return [];
  return (events ?? [])
    .filter((e) => {
      if (e.taskStepId !== stepRowId) return false;
      const evInvocation = e.payload?.invocationId;
      return typeof evInvocation === 'string' ? evInvocation === invocationId : true;
    })
    .map((e) => ({
      id: `history:${e.id}`,
      text: typeof e.payload?.text === 'string' ? e.payload.text : '(no text recorded)',
      status: 'historical' as const,
    }));
}
