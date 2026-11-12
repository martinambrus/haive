import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { checkoutMissing } from '../repo/checkout-head.js';
import { settleProjections } from '../step-engine/merge-projections.js';
import { resyncHaiveProjections } from './set-aside.js';

/** Also visits clean outbox rows and legacy done merge states: neither owes a step Retry. */
export async function sweepKeptProjectionMetadata(db: Database): Promise<number> {
  const pending = await db
    .select({
      repositoryId: schema.projectStateOutbox.repositoryId,
      storagePath: schema.repositories.storagePath,
      localPath: schema.repositories.localPath,
      kept: schema.projectStateOutbox.keptMetadata,
    })
    .from(schema.projectStateOutbox)
    .innerJoin(
      schema.repositories,
      eq(schema.repositories.id, schema.projectStateOutbox.repositoryId),
    )
    .where(isNotNull(schema.projectStateOutbox.keptMetadata))
    .orderBy(asc(schema.projectStateOutbox.updatedAt))
    .limit(25);
  let settled = 0;
  for (const row of pending) {
    try {
      const path = row.storagePath ?? row.localPath;
      if (
        path &&
        row.kept?.[path] &&
        !(await checkoutMissing(path)) &&
        (await resyncHaiveProjections(db, row.repositoryId, path)) &&
        (await metadataSettled(db, row.repositoryId))
      )
        settled++;
    } catch (err) {
      logger.warn(
        { err, repositoryId: row.repositoryId },
        'captured projection metadata recovery failed',
      );
    }
    // Held rows go behind other obligations even when their projection revisions are clean.
    await db
      .update(schema.projectStateOutbox)
      .set({ updatedAt: new Date() })
      .where(eq(schema.projectStateOutbox.repositoryId, row.repositoryId));
  }

  const legacy = await db
    .select({
      id: schema.taskSteps.id,
      repositoryId: schema.tasks.repositoryId,
      state: schema.taskSteps.mergeResolveState,
    })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.tasks.repositoryId))
    .where(
      and(
        isNotNull(schema.tasks.repositoryId),
        sql`${schema.taskSteps.mergeResolveState}->>'mergeDir' = coalesce(${schema.repositories.storagePath}, ${schema.repositories.localPath})`,
        sql`${schema.taskSteps.mergeResolveState}->>'phase' = 'done'`,
        sql`${schema.taskSteps.mergeResolveState}->>'mode' = 'same-branch'`,
        sql`${schema.taskSteps.mergeResolveState}->'keptMetadata' IS NOT NULL`,
      ),
    )
    .orderBy(asc(schema.taskSteps.updatedAt))
    .limit(25);
  for (const row of legacy) {
    const state = row.state!;
    let expected = state;
    try {
      if (
        !(await checkoutMissing(state.mergeDir)) &&
        (await settleProjections(db, row.repositoryId!, state, async (next, handle) => {
          // Do not replace a newer merge state with the snapshot this sweep read.
          const rows = await handle
            .update(schema.taskSteps)
            .set({
              mergeResolveState: next,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.taskSteps.id, row.id),
                sql`${schema.taskSteps.mergeResolveState} = ${JSON.stringify(expected)}::jsonb`,
              ),
            )
            .returning({ id: schema.taskSteps.id });
          if (rows.length === 0) return false;
          expected = next;
          return true;
        })) &&
        (await metadataSettled(db, row.repositoryId!))
      )
        settled++;
    } catch (err) {
      logger.warn({ err, stepId: row.id }, 'completed merge metadata recovery failed');
    }
    await db
      .update(schema.taskSteps)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(schema.taskSteps.id, row.id),
          sql`${schema.taskSteps.mergeResolveState} = ${JSON.stringify(state)}::jsonb`,
        ),
      );
  }
  return settled;
}

/** A successful re-sync may still owe absent paths or a concurrently captured entry. */
async function metadataSettled(db: Database, repositoryId: string): Promise<boolean> {
  const [row] = await db
    .select({ kept: schema.projectStateOutbox.keptMetadata })
    .from(schema.projectStateOutbox)
    .where(eq(schema.projectStateOutbox.repositoryId, repositoryId))
    .limit(1);
  return !row?.kept || Object.keys(row.kept).length === 0;
}
