import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { CliTokenUsage } from '@haive/shared';
import { log } from './_shared.js';

/** Build a callback that persists a RUNNING token-usage snapshot onto the
 *  in-flight cli_invocations row, so the task page + terminal polls show a live,
 *  growing token count before the invocation completes. The caller fires this on
 *  a throttle (an interval); an in-flight guard drops a snapshot while a prior
 *  write is still pending so writes never overlap. Best-effort — a failed write
 *  logs and is retried on the next tick. The final authoritative tokenUsage is
 *  still written on completion (handlers.ts). Returns undefined when there is no
 *  invocation row to update (nothing to surface). */
export function makeUsageSnapshotPersister(
  db: Database,
  invocationId: string | null | undefined,
): ((usage: CliTokenUsage | null) => void) | undefined {
  if (!invocationId) return undefined;
  let inFlight = false;
  return (usage: CliTokenUsage | null) => {
    if (!usage || inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        await db
          .update(schema.cliInvocations)
          .set({ tokenUsage: usage })
          .where(eq(schema.cliInvocations.id, invocationId));
      } catch (err) {
        log.warn({ err, invocationId }, 'running token-usage snapshot persist failed');
      } finally {
        inFlight = false;
      }
    })();
  };
}
