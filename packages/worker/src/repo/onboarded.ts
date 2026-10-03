import { and, eq, exists, isNull, lt, or, sql } from 'drizzle-orm';
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
    const now = new Date();
    // ONE statement, deliberately. Reading the task and then updating the repository leaves a
    // read->write gap, and that gap is wide here rather than theoretical: `markTaskCompleted`
    // commits `completed` and then runs container teardown and two Ollama unloads before it gets
    // this far, so a reset has plenty of room to land in between and see nothing live.
    const stamped = await db
      .update(schema.repositories)
      .set({ onboardedAt: now, updatedAt: now })
      .where(
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.tasks)
            .where(
              and(
                eq(schema.tasks.id, taskId),
                eq(schema.tasks.repositoryId, schema.repositories.id),
                // `onboarding_upgrade` reconciles template artifacts on an already-onboarded
                // repo and says nothing about whether onboarding itself ever ran.
                eq(schema.tasks.type, 'onboarding'),
                // Checked here, not just by the caller: a cancel landing in the window above
                // flips the row terminal while this is still in flight, and the old code would
                // have stamped anyway because it never looked at the status at all.
                eq(schema.tasks.status, 'completed'),
                // A run that finished BEFORE the repository was reset describes a tree that no
                // longer exists. Stamping from it re-asserts "onboarded" over artifacts the
                // reset deleted, and no lock can prevent that — by the time this runs the task
                // is already terminal, so every live-task guard has stopped seeing it.
                or(
                  isNull(schema.repositories.onboardingResetAt),
                  lt(schema.repositories.onboardingResetAt, schema.tasks.completedAt),
                ),
              ),
            ),
        ),
      )
      .returning({ repositoryId: schema.repositories.id });

    const repositoryId = stamped[0]?.repositoryId;
    if (repositoryId) {
      logger.info(
        { taskId, repositoryId },
        'repository marked onboarded by completed onboarding run',
      );
    }
  } catch (err) {
    logger.warn({ err, taskId }, 'failed to stamp repository onboarded_at');
  }
}
