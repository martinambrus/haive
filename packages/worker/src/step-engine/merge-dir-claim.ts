import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

type DbHandle = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/** Phases whose merge dir still holds the task's work: an open merge, or a landed one the squash or
 *  the push has yet to finish. `pending` has opened nothing, and `done` has released the dir. */
const HELD_MERGE_PHASES = ['resolving', 'awaiting-guidance', 'squashing', 'pushing'] as const;

/** A merge left by a task in one of these is stale, and is cleaned up by the next merge there. A
 *  failed task is not among them: its Retry resumes the merge it left open. */
const ENDED_TASK_STATUSES = ['completed', 'cancelled'] as const;

export interface MergeDirHolder {
  id: string;
  title: string;
}

/** First thing in the transaction that checks, clears and opens a merge in `mergeDir`. The
 *  directory is keyed rather than the repository: two repository rows can share one local path. */
export async function lockMergeDir(tx: DbHandle, mergeDir: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`merge-dir:${mergeDir}`}, 0))`,
  );
}

/** Another live task whose recorded merge still holds `mergeDir`, so aborting what is open there
 *  would destroy its work. The record is `task_steps.merge_resolve_state`, written before any park. */
export async function findOtherMergeHolder(
  db: DbHandle,
  params: { mergeDir: string; taskId: string },
): Promise<MergeDirHolder | null> {
  const [row] = await db
    .select({ id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
    .where(
      and(
        ne(schema.taskSteps.taskId, params.taskId),
        notInArray(schema.tasks.status, [...ENDED_TASK_STATUSES]),
        sql`${schema.taskSteps.mergeResolveState} ->> 'mergeDir' = ${params.mergeDir}`,
        inArray(sql<string>`${schema.taskSteps.mergeResolveState} ->> 'phase'`, [
          ...HELD_MERGE_PHASES,
        ]),
      ),
    )
    .limit(1);
  return row ? { id: row.id, title: row.title } : null;
}
