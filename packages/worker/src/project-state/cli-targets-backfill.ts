import { and, eq, isNull, inArray } from 'drizzle-orm';
import { isRootClaimLive, lockRepositoryTasksKey, schema, type Database } from '@haive/database';
import {
  isRenderContextSnapshot,
  readRenderContextColumn,
  recordedCliTargets,
  pickSnapshotRow,
  completeRecordedCliMembership,
  recoverCliTargets,
  recoverCliMembership,
  type RenderContextColumn,
} from '@haive/shared/project-state';
import { CHECKOUT_HOLDING_TASK_STATUSES } from '@haive/shared';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { lockProjectState } from './write.js';

export { recoverCliTargets };

/** JSON-only convergent boot backfill, before applicable sets are recomputed. No SQL approximation
 * of the strict decoder and no schema migration/CLI membership inferred from today's user. */
export async function seedRepositoryCliTargets(db: Database): Promise<void> {
  const repos = await db.select({ id: schema.repositories.id }).from(schema.repositories);
  for (const repo of repos)
    await db.transaction(async (tx) => {
      await lockRepositoryTasksKey(tx, repo.id);
      await lockProjectState(tx, repo.id);
      const [stored] = await tx
        .select({
          renderContext: schema.repositories.renderContext,
          rtkChoiceMadeAt: schema.repositories.rtkChoiceMadeAt,
          rootClaimedAt: schema.repositories.rootClaimedAt,
        })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, repo.id))
        .for('update');
      if (!stored || isRootClaimLive(stored.rootClaimedAt)) return;
      const [holder] = await tx
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.repositoryId, repo.id),
            inArray(schema.tasks.type, ['onboarding', 'onboarding_upgrade']),
            inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
            isNull(schema.tasks.deadAt),
          ),
        )
        .limit(1);
      const [outbox] = await tx
        .select({ intent: schema.projectStateOutbox.writeIntent })
        .from(schema.projectStateOutbox)
        .where(eq(schema.projectStateOutbox.repositoryId, repo.id));
      if (holder || outbox?.intent) return;
      const read = readRenderContextColumn(stored.renderContext);
      if (read.kind === 'column' && read.column.cliTargets !== undefined) return;
      const rows = await tx
        .select({
          id: schema.onboardingArtifacts.id,
          generatedAt: schema.onboardingArtifacts.generatedAt,
          formValuesSnapshot: schema.onboardingArtifacts.formValuesSnapshot,
        })
        .from(schema.onboardingArtifacts)
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, repo.id),
            isNull(schema.onboardingArtifacts.supersededAt),
          ),
        );
      const recovered = recoverCliMembership(rows);
      const cliTargets =
        recovered?.cliTargets ??
        (read.kind === 'column' ? recordedCliTargets(read.column) : undefined);
      if (cliTargets === undefined) return;
      // Membership follows the newest valid snapshot. The rest of a recovered context still
      // follows the shared RTK-aware origin policy, which can deliberately choose an older row.
      const baseline = pickSnapshotRow(
        rows.map((row) => {
          const valid = isRenderContextSnapshot(row.formValuesSnapshot);
          return {
            ...row,
            hasSnapshot: valid,
            rtkRecorded:
              valid &&
              typeof (row.formValuesSnapshot as { rtkEnabled?: unknown })?.rtkEnabled === 'boolean',
          };
        }),
        stored.rtkChoiceMadeAt,
      );
      const snapshot = baseline?.formValuesSnapshot as
        Omit<RenderContextColumn, 'rtkChoiceRecorded'> | undefined;
      const context = read.kind === 'column' ? read.column : snapshot;
      if (!context) return;
      const completed = completeRecordedCliMembership(
        read.kind === 'column' ? context : { ...context, cliTargets: undefined },
        recovered,
      );
      await tx
        .update(schema.repositories)
        .set({
          renderContext: {
            ...completed,
            cliTargets,
            rtkChoiceRecorded:
              read.kind === 'column'
                ? read.column.rtkChoiceRecorded
                : typeof snapshot?.rtkEnabled === 'boolean' || stored.rtkChoiceMadeAt !== null,
          },
        })
        .where(eq(schema.repositories.id, repo.id));
      await markProjectStateDirty(tx, repo.id);
    });
}
