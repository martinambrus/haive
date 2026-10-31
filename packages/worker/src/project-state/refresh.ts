import { checkoutMissing, type NamedCheckout } from '../repo/checkout-head.js';
import { and, asc, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { safeErrorMessage } from '@haive/shared/logger';
import { readRenderContextColumn } from '@haive/shared/project-state';
import { gitOperationInProgress } from '../repo/git-operation.js';
import { syncProjectStateFromCheckout } from './sync.js';
import {
  ProjectStateCheckoutHeldError,
  ProjectStateMovedError,
  ProjectStateRecoveryHeldError,
  recoverProjectStateWrite,
  writeProjectStateColumn,
} from './write.js';

const SWEEP_BATCH = 25;

const NOT_WRITTEN = {
  deferred: 'an onboarding, an upgrade or a reset holds the checkout',
  superseded: 'the repository changed while its record was being read',
  missing:
    "the repository's checkout directory is missing; nothing was written. The record is written again once it is back.",
} as const;

async function setOutboxError(
  db: Database,
  repositoryId: string,
  message: string,
  onlyIfDirty = false,
): Promise<void> {
  await db
    .update(schema.projectStateOutbox)
    .set({ lastError: message.slice(0, 500), updatedAt: new Date() })
    .where(
      and(
        eq(schema.projectStateOutbox.repositoryId, repositoryId),
        onlyIfDirty
          ? lt(schema.projectStateOutbox.writtenRevision, schema.projectStateOutbox.revision)
          : undefined,
        sql`${schema.projectStateOutbox.lastError} IS DISTINCT FROM ${message.slice(0, 500)}`,
      ),
    );
}

/** A row the sweep could not write goes to the back of the queue, so rows that stay stuck cannot
 *  starve the rest of the batch. */
async function touchOutbox(db: Database, repositoryId: string): Promise<void> {
  await db
    .update(schema.projectStateOutbox)
    .set({ updatedAt: new Date() })
    .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
}

/** Marks every repository holding a render context dirty, so the first sweep after a boot brings the
 *  record up to date with whatever a release now writes. A row still dirty is left as it is. */
export async function markProjectStatesDirtyAtBoot(db: Database): Promise<void> {
  await db.execute(sql`
    INSERT INTO project_state_outbox (repository_id, revision, written_revision, updated_at)
    SELECT id, 1, 0, now() FROM repositories WHERE render_context IS NOT NULL
    ON CONFLICT (repository_id) DO UPDATE
      SET revision = project_state_outbox.revision + 1, last_error = NULL, updated_at = now()
      WHERE project_state_outbox.written_revision >= project_state_outbox.revision
  `);
}

export async function refreshProjectState(
  db: Database,
  repositoryId: string,
  expectedCheckout?: NamedCheckout,
): Promise<boolean> {
  const [repo] = await db
    .select({
      storagePath: schema.repositories.storagePath,
      localPath: schema.repositories.localPath,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  const repoPath = repo?.storagePath ?? repo?.localPath ?? null;
  if (!repoPath) return false;
  // The row stays dirty: that is the signal to write the record once the checkout is back.
  if (await checkoutMissing(repoPath)) {
    await setOutboxError(db, repositoryId, NOT_WRITTEN.missing, true);
    return false;
  }
  if (await gitOperationInProgress(repoPath)) return false;

  try {
    await recoverProjectStateWrite(db, repositoryId, repoPath, expectedCheckout);
  } catch (err) {
    if (err instanceof ProjectStateRecoveryHeldError) {
      await setOutboxError(db, repositoryId, err.message);
      return false;
    }
    if (err instanceof ProjectStateCheckoutHeldError) {
      // Operational metadata only: a refused writer must not change revisions, intent or state.
      await setOutboxError(db, repositoryId, NOT_WRITTEN.deferred, true);
      return false;
    }
    if (err instanceof ProjectStateMovedError) return false;
    throw err;
  }
  const synced = await syncProjectStateFromCheckout(db, {
    repositoryId,
    repoPath,
    refuseDuringGitOperation: true,
    expectedCheckout,
  });
  if (synced.outcome === 'held') return false;
  if (synced.outcome === 'refused') {
    await setOutboxError(db, repositoryId, synced.reason ?? 'the checkout record was refused');
    return false;
  }
  if (synced.outcome === 'deferred' || synced.outcome === 'superseded') {
    await setOutboxError(db, repositoryId, NOT_WRITTEN[synced.outcome]);
    return false;
  }

  const [after] = await db
    .select({
      renderContext: schema.repositories.renderContext,
      onboardingResetAt: schema.repositories.onboardingResetAt,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  const read = readRenderContextColumn(after?.renderContext ?? null);
  if (read.kind === 'absent') return false;
  if (read.kind === 'refused') {
    await setOutboxError(
      db,
      repositoryId,
      `the render context is not valid: ${read.problems.join('; ')}`,
    );
    return false;
  }
  try {
    await writeProjectStateColumn(db, {
      repositoryId,
      repoPath,
      column: read.column,
      expectedColumns: [after!.renderContext],
      expectedResetAt: after!.onboardingResetAt,
      keepColumnOnFailure: true,
      refuseDuringGitOperation: true,
      expectedCheckout,
      refuseWhileHeld: true,
    });
  } catch (err) {
    if (err instanceof ProjectStateCheckoutHeldError) {
      // Operational metadata only: a refused writer must not change revisions, intent or state.
      await setOutboxError(db, repositoryId, NOT_WRITTEN.deferred, true);
      return false;
    }
    if (err instanceof ProjectStateMovedError) return false;
    throw err;
  }
  return true;
}

/** Rewrites the record of each repository whose outbox row is dirty. Writes only; the commit is
 *  whoever commits the repository. A refused, deferred or superseded sync writes nothing and keeps
 *  the row dirty with its reason, and a record that moved under the write waits for the next tick. */
export async function sweepDirtyProjectStates(db: Database): Promise<number> {
  const dirty = await db
    .select({ repositoryId: schema.projectStateOutbox.repositoryId })
    .from(schema.projectStateOutbox)
    .innerJoin(
      schema.repositories,
      eq(schema.repositories.id, schema.projectStateOutbox.repositoryId),
    )
    .where(
      and(
        lt(schema.projectStateOutbox.writtenRevision, schema.projectStateOutbox.revision),
        or(
          isNotNull(schema.repositories.renderContext),
          isNotNull(schema.projectStateOutbox.writeIntent),
        ),
      ),
    )
    .orderBy(asc(schema.projectStateOutbox.updatedAt))
    .limit(SWEEP_BATCH);
  let written = 0;
  for (const { repositoryId } of dirty) {
    try {
      if (await refreshProjectState(db, repositoryId)) written++;
      else await touchOutbox(db, repositoryId);
    } catch (err) {
      logger.warn({ err, repositoryId }, 'dirty project state refresh failed');
      await setOutboxError(db, repositoryId, safeErrorMessage(err)).catch(() => undefined);
      await touchOutbox(db, repositoryId).catch(() => undefined);
    }
  }
  return written;
}
