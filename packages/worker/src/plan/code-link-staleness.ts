import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { markPlanMirrorDirty } from '@haive/shared/plan';
import { flushPlanMirrorForRepository } from './mirror.js';

/**
 * Mark a plan's code links stale for the paths a task changed.
 *
 * Link rot is the failure mode that makes an impact view LIE. A link recorded at
 * one commit says "this file implements that component", and every merge is a
 * chance for that to stop being true — the file moves, splits, or stops doing the
 * thing. Nothing can detect that automatically, so the honest move is to record
 * that the evidence is OLD rather than to keep presenting it as current.
 *
 * The flag is the difference between a wrong answer and an old one. It is cleared
 * by re-assertion, not by time: a later plan agent that opens the file and links
 * it again sets `stale = false` (see `writeCodeLinks` in the applier), because
 * that is the only event that constitutes fresh evidence.
 *
 * Best-effort. This is telemetry about confidence, and it must never fail the
 * reindex that triggered it.
 */
export async function markPlanCodeLinksStale(
  db: Database,
  taskId: string,
): Promise<{ marked: number }> {
  try {
    const [task] = await db
      .select({
        repositoryId: schema.tasks.repositoryId,
        changedPaths: schema.tasks.changedPaths,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1);

    const paths = task?.changedPaths ?? [];
    if (!task?.repositoryId || paths.length === 0) return { marked: 0 };

    // Scoped to paths this task actually touched, and to links that are not
    // already flagged — re-flagging an old one would reset nothing and write for
    // no reason.
    const marked = await db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.planNodeCodeLinks)
        .set({ stale: true, updatedAt: new Date() })
        .where(
          and(
            eq(schema.planNodeCodeLinks.repositoryId, task.repositoryId!),
            inArray(schema.planNodeCodeLinks.repoPath, paths),
            eq(schema.planNodeCodeLinks.stale, false),
          ),
        )
        .returning({ id: schema.planNodeCodeLinks.id });
      if (rows.length > 0) await markPlanMirrorDirty(tx, task.repositoryId!);
      return rows;
    });

    if (marked.length > 0) {
      logger.info(
        { taskId, repositoryId: task.repositoryId, marked: marked.length },
        'plan code links marked stale for paths this task changed',
      );
      await flushPlanMirrorForRepository(db, task.repositoryId).catch((err) => {
        logger.warn({ err, repositoryId: task.repositoryId }, 'stale-link mirror refresh failed');
      });
    }
    return { marked: marked.length };
  } catch (err) {
    logger.warn({ err, taskId }, 'plan code-link staleness pass failed (non-fatal)');
    return { marked: 0 };
  }
}
