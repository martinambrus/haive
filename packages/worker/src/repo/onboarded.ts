import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';

/**
 * A completed onboarding run stamps its repository as onboarded.
 *
 * "Is this repo onboarded" used to be answered by stat-ing four paths — `.claude/agents`,
 * `.claude/skills`, `.claude/workflow-config.json` and the knowledge base — every one of
 * which is written by 07-generate-files, the 8th of 27 onboarding steps. A run cancelled at
 * KB QA and a run executing right now leave exactly the same files, so both read as
 * finished: the next task on such a repo was created as a `workflow` task against a
 * knowledge base nobody finished building.
 *
 * Hooked onto `markTaskCompleted` for the same reason `completePlanNodesForTask` is — cancel
 * and fail write through their own functions, so an abandoned run can never stamp a repo.
 *
 * Best-effort. The API's verdict also accepts "a completed onboarding task exists" as
 * evidence, so a lost write here costs nothing but the column, and a bookkeeping failure
 * must not break a terminal transition.
 */
export async function stampRepositoryOnboarded(db: Database, taskId: string): Promise<void> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { id: true, type: true, repositoryId: true },
    });
    // `onboarding_upgrade` reconciles template artifacts on an already-onboarded repo and
    // says nothing about whether onboarding itself ever ran.
    if (!task || task.type !== 'onboarding' || !task.repositoryId) return;

    await db
      .update(schema.repositories)
      .set({ onboardedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.repositories.id, task.repositoryId));
    logger.info(
      { taskId, repositoryId: task.repositoryId },
      'repository marked onboarded by completed onboarding run',
    );
  } catch (err) {
    logger.warn({ err, taskId }, 'failed to stamp repository onboarded_at');
  }
}
