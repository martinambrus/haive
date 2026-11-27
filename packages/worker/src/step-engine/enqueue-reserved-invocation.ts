import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, type CliExecJobPayload } from '@haive/shared';
import { serializeError } from '@haive/shared/logger';
import type { WorkerDeps } from './step-runner.js';

/** Release this pass's reservation if enqueue fails, as prepareWorkspace does.
 * A lost queue acknowledgement may still have queued it; superseding also fences
 * that job, while a failed step and its later Retry owe no live reservation. */
export async function enqueueReservedInvocation(
  db: Database,
  deps: Pick<WorkerDeps, 'enqueueCliInvocation'>,
  payload: CliExecJobPayload,
): Promise<void> {
  try {
    await deps.enqueueCliInvocation(payload);
  } catch (err) {
    try {
      await db
        .update(schema.cliInvocations)
        .set({ supersededAt: new Date() })
        .where(eq(schema.cliInvocations.id, payload.invocationId));
    } catch (releaseErr) {
      logger.warn(
        { err: serializeError(releaseErr), invocationId: payload.invocationId },
        'failed to release unqueued invocation reservation',
      );
    }
    throw err;
  }
}
