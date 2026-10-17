import { isDeepStrictEqual } from 'node:util';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, type OnboardingToolingMirror } from '@haive/shared';
import { convergeRtkQuestion } from '@haive/shared/rtk-enabled';
import { RTK_ENABLED_UNIT, conflictSide, isRtkChoiceRecorded } from '@haive/shared/project-state';
import { lockProjectState } from './write.js';

export interface RtkQuestionInput {
  /** The `tooling` object of the repository's stored `onboarding_tooling`. */
  importedTooling: Record<string, unknown> | null | undefined;
  rtkEnabled: boolean;
  /** The `tooling` each local 04 run of the repository output. */
  local04Toolings: readonly unknown[];
  /** A row for the unit of any resolution, so an answered question is never asked again. */
  hasAnyRowForUnit: boolean;
  rtkChoiceMadeAt: Date | null;
}

/** Asks only where nobody switched RTK (no `rtk_choice_made_at`); a stamped repository's column is a person's choice. */
export function needsRtkQuestion(input: RtkQuestionInput): boolean {
  return (
    !isRtkChoiceRecorded(false, input.rtkChoiceMadeAt) &&
    input.importedTooling?.rtkEnabled === false &&
    input.rtkEnabled === true &&
    !input.local04Toolings.some((t) => isDeepStrictEqual(t, input.importedTooling)) &&
    !input.hasAnyRowForUnit
  );
}

const toolingOf = (stored: unknown): Record<string, unknown> | null => {
  const tooling = (stored as OnboardingToolingMirror | null)?.tooling as unknown;
  return tooling !== null && typeof tooling === 'object' && !Array.isArray(tooling)
    ? (tooling as Record<string, unknown>)
    : null;
};

/** Opens the question for a repository that needs it. Idempotent: a pending row, or one answered,
 *  stands in the way of another. Returns whether a row was written. */
export async function raiseRtkQuestion(db: Database, repositoryId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockProjectState(tx, repositoryId);
    const [repo] = await tx
      .select({
        onboardingTooling: schema.repositories.onboardingTooling,
        rtkEnabled: schema.repositories.rtkEnabled,
        rtkChoiceMadeAt: schema.repositories.rtkChoiceMadeAt,
      })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repositoryId))
      .limit(1)
      // Every writer of rtk_enabled updates this row, so a question cannot be raised past a switch-off.
      .for('update');
    if (repo && (!repo.rtkEnabled || isRtkChoiceRecorded(false, repo.rtkChoiceMadeAt))) {
      await convergeRtkQuestion(tx, repositoryId, null);
      return false;
    }
    const importedTooling = toolingOf(repo?.onboardingTooling);
    if (!repo || importedTooling?.rtkEnabled !== false) return false;
    const taskIds = (
      await tx
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.repositoryId, repositoryId))
    ).map((t) => t.id);
    const local04 =
      taskIds.length === 0
        ? []
        : await tx
            .select({ output: schema.taskSteps.output })
            .from(schema.taskSteps)
            .where(
              and(
                inArray(schema.taskSteps.taskId, taskIds),
                eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
              ),
            );
    const rows = await tx
      .select({ id: schema.projectStateConflicts.id })
      .from(schema.projectStateConflicts)
      .where(
        and(
          eq(schema.projectStateConflicts.repositoryId, repositoryId),
          eq(schema.projectStateConflicts.unit, RTK_ENABLED_UNIT),
        ),
      )
      .limit(1);
    if (
      !needsRtkQuestion({
        importedTooling,
        rtkEnabled: repo.rtkEnabled,
        local04Toolings: local04.map((r) => (r.output as { tooling?: unknown } | null)?.tooling),
        hasAnyRowForUnit: rows.length > 0,
        rtkChoiceMadeAt: repo.rtkChoiceMadeAt,
      })
    ) {
      return false;
    }
    const written = await tx
      .insert(schema.projectStateConflicts)
      .values({
        repositoryId,
        unit: RTK_ENABLED_UNIT,
        base: conflictSide(true),
        local: conflictSide(true),
        incoming: conflictSide(false),
      })
      .onConflictDoNothing({
        target: [schema.projectStateConflicts.repositoryId, schema.projectStateConflicts.unit],
        where: isNull(schema.projectStateConflicts.resolvedAt),
      })
      .returning({ id: schema.projectStateConflicts.id });
    return written.length > 0;
  });
}

/** Boot entry: asks the question of every repository that needs it, and closes one whose RTK is off by
 *  now. A failure for one is logged and leaves the others. */
export async function raiseRtkQuestions(db: Database): Promise<void> {
  const pending = new Set(
    (
      await db
        .select({ repositoryId: schema.projectStateConflicts.repositoryId })
        .from(schema.projectStateConflicts)
        .where(
          and(
            eq(schema.projectStateConflicts.unit, RTK_ENABLED_UNIT),
            isNull(schema.projectStateConflicts.resolvedAt),
          ),
        )
    ).map((r) => r.repositoryId),
  );
  const repos = await db
    .select({
      id: schema.repositories.id,
      onboardingTooling: schema.repositories.onboardingTooling,
      rtkEnabled: schema.repositories.rtkEnabled,
    })
    .from(schema.repositories);
  for (const repo of repos) {
    const asks = repo.rtkEnabled && toolingOf(repo.onboardingTooling)?.rtkEnabled === false;
    if (!asks && !pending.has(repo.id)) continue;
    try {
      if (await raiseRtkQuestion(db, repo.id)) {
        logger.warn(
          { repositoryId: repo.id },
          'imported RTK-off never applied on this install; asking which to keep',
        );
      }
    } catch (err) {
      logger.warn({ err, repositoryId: repo.id }, 'RTK question not raised');
    }
  }
}
