import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { readLiveRootClaim, schema, type Database } from '@haive/database';
import { CHECKOUT_HOLDING_TASK_STATUSES } from '@haive/shared';
import type { ProjectStateSweepOutcome } from '../../src/project-state/refresh.js';
import { checkoutHoldingTasks } from '../../src/repo/refresh.js';
import { gitOperationMarker } from '../../src/repo/git-operation.js';
import { gitRun } from '../../src/repo/git-exec.js';

/** Read-only snapshot of a dirty repository immediately after its actual sweep attempt.
 * synced_hash belongs to project_state_sync, not the outbox. No writer is called here. */
export async function projectStateSweepDiagnostic(
  db: Database,
  repositoryId: string,
  refresh: ProjectStateSweepOutcome,
) {
  const rows = await db.execute<{
    revision: number;
    written_revision: number;
    last_error: string | null;
    synced_hash: string | null;
    repo_path: string | null;
  }>(sql`
    select o.revision, o.written_revision, left(o.last_error, 500) as last_error,
           s.synced_hash, coalesce(r.storage_path, r.local_path) as repo_path
    from project_state_outbox o
    join repositories r on r.id = o.repository_id
    left join project_state_sync s on s.repository_id = o.repository_id
    where o.repository_id = ${repositoryId} and o.written_revision < o.revision
  `);
  const row = rows[0];
  if (!row) return null;
  const { repo_path: repoPath, ...outbox } = row;
  // Pool reads hold no transaction across Git. A failed probe must not hide its siblings.
  const probes = await Promise.allSettled([
    readLiveRootClaim(db, repositoryId),
    checkoutHoldingTasks(db, repositoryId, { rootOnly: true }),
    db
      .select({
        id: schema.tasks.id,
        type: schema.tasks.type,
        status: schema.tasks.status,
        worktreePath: schema.tasks.worktreePath,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.repositoryId, repositoryId),
          inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
          isNull(schema.tasks.deadAt),
        ),
      )
      .limit(10),
    repoPath ? gitOperationMarker(repoPath) : Promise.resolve(null),
    repoPath
      ? gitRun(
          repoPath,
          ['status', '--porcelain=v2', '--branch'],
          {
            GIT_OPTIONAL_LOCKS: '0',
          },
          { maxBuffer: 8192, timeout: 10_000 },
        )
      : Promise.resolve(null),
  ]);
  const value = (index: number) => {
    const probe = probes[index]!;
    return probe.status === 'fulfilled'
      ? probe.value
      : { error: String(probe.reason).slice(0, 500) };
  };
  return {
    repositoryId,
    capturedAt: new Date().toISOString(),
    refresh,
    outbox,
    rootClaim: value(0),
    rootCheckoutHolders: value(1),
    checkoutHolders: value(2),
    gitOperationMarker: value(3),
    gitStatus: value(4),
  };
}
