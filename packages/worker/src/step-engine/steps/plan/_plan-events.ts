import { schema } from '@haive/database';
import type { StepContext } from '../../step-definition.js';

export const CODE_LINKS_DROPPED = 'plan.code_links_dropped';

/** How many of the dropped links ride in the payload. The list can be long —
 *  MEASURED, one reply keyed all 59 of its links `path` instead of `repoPath` —
 *  and the Activity tab renders the payload as JSON, so the count carries the
 *  scale while a handful of entries carry the shape. */
const SAMPLE_SIZE = 5;

/**
 * Record code links the applier could not store, where a person actually looks.
 *
 * Deliberately NOT the mining row's stamp: its prefixes drive
 * `findStructuralGaps` and `askedState`, and a stripped link costs no op, so a
 * PARTIAL stamp would have the coverage gate offer a repair agent for a lost
 * annotation. A task event needs no web change — the Activity tab renders any
 * event type, with its payload as JSON.
 *
 * Best-effort, like the stamps beside it: losing the note must not lose the wave.
 */
export async function recordCodeLinksDropped(
  ctx: StepContext,
  agentId: string,
  stripped: string[],
): Promise<void> {
  if (stripped.length === 0) return;
  try {
    await ctx.db.insert(schema.taskEvents).values({
      taskId: ctx.taskId,
      taskStepId: ctx.taskStepId,
      eventType: CODE_LINKS_DROPPED,
      payload: { agentId, count: stripped.length, sample: stripped.slice(0, SAMPLE_SIZE) },
    });
  } catch (err) {
    ctx.logger.warn({ err, agentId }, 'could not record dropped code links');
  }
}
