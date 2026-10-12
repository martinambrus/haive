import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { DbHandle } from '../step-engine/merge-dir-claim.js';

const LOCK_RETRY_FIRST_MS = 100;
const LOCK_RETRY_MAX_MS = 1000;

/** Same polling shape as inMergeDirLock: a fresh transaction per attempt, so a waiter holds no
 *  pooled connection between attempts. */
async function inTaskSandboxFence<T>(
  db: Database,
  taskId: string,
  fn: (tx: DbHandle) => Promise<T>,
): Promise<T> {
  let delay = LOCK_RETRY_FIRST_MS;
  for (;;) {
    const got = await db.transaction(async (tx) => {
      const rows = await tx.execute<{ ok: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`cli-sandbox:${taskId}`}, 0)) as ok`,
      );
      return rows[0]?.ok ? { value: await fn(tx) } : null;
    });
    if (got) return got.value;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }
}

/** Runs `create` only if the run is still live, under the task's fence; null when it is not. Held
 *  across the container create alone, never the container's run. */
export async function createUnlessSuperseded<T>(
  db: Database,
  run: { taskId: string; invocationId: string },
  create: () => Promise<T>,
): Promise<T | null> {
  return inTaskSandboxFence(db, run.taskId, async (tx) => {
    const [row] = await tx
      .select({
        endedAt: schema.cliInvocations.endedAt,
        supersededAt: schema.cliInvocations.supersededAt,
      })
      .from(schema.cliInvocations)
      .where(eq(schema.cliInvocations.id, run.invocationId));
    if (row?.endedAt || row?.supersededAt) return null;
    return create();
  });
}

/** Marks the task's open runs superseded under the fence, so a create that already passed its check
 *  has finished (and shows in the sandbox listing) before this returns. */
export async function supersedeTaskRuns(db: Database, taskId: string): Promise<void> {
  await inTaskSandboxFence(db, taskId, async (tx) => {
    await tx
      .update(schema.cliInvocations)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(schema.cliInvocations.taskId, taskId),
          isNull(schema.cliInvocations.endedAt),
          isNull(schema.cliInvocations.supersededAt),
        ),
      );
  });
}
