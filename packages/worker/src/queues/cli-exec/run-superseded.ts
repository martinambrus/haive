import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { getDb } from '../../db.js';
import { log } from './_shared.js';

export const SUPERSEDED_POLL_MS = 5_000;
export const SUPERSEDED_RUN_ERROR = 'The run was superseded by a Retry or a Stop.';

/** Whether a Retry or a Stop superseded this run. A read that fails answers false: their own kill
 *  has run, and this check only covers a sandbox that started after it. */
export async function isRunSuperseded(invocationId: string): Promise<boolean> {
  try {
    const [row] = await getDb()
      .select({ supersededAt: schema.cliInvocations.supersededAt })
      .from(schema.cliInvocations)
      .where(eq(schema.cliInvocations.id, invocationId));
    return row?.supersededAt != null;
  } catch (err) {
    log.warn({ err, invocationId }, 'could not read whether the run was superseded');
    return false;
  }
}

/** Aborts once the run reads superseded, read every SUPERSEDED_POLL_MS until stopped. */
export function watchSupersededRun(
  invocationId: string,
  check: (id: string) => Promise<boolean> = isRunSuperseded,
): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  let reading = false;
  const timer = setInterval(() => {
    if (reading || controller.signal.aborted) return;
    reading = true;
    void check(invocationId)
      .then((superseded) => {
        if (superseded) controller.abort();
      })
      .finally(() => {
        reading = false;
      });
  }, SUPERSEDED_POLL_MS);
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}
