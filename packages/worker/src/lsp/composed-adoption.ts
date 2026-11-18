import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { composedLspRunListEligible } from '@haive/shared/run-list';
import { decideComposedLspProviderLock } from '@haive/shared/composed-lsp-provider-lock';
import { taskRunListStepIds } from './final-verification.js';

/** Rollback switch: false stops NEW environments adopting contract 2 only; a stored 2 keeps being carried and read. */
export const COMPOSED_LSP_NEW_ENVIRONMENT_ADOPTION = true;

/** The language-server keys the composed installation can serve. */
export const COMPOSED_LSP_ADOPTABLE_KEYS: readonly string[] = [
  'intelephense',
  'intelephense-extended',
];

/** True for a non-empty selection made only of adoptable keys. */
export function isComposedLspSelection(keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((key) => COMPOSED_LSP_ADOPTABLE_KEYS.includes(key));
}

/** Every provider id this task could run a step on, over-approximated. */
async function collectProviderIds(
  db: Database,
  args: { taskId: string; userId: string; defaultProviderId: string | null; stepIds: string[] },
): Promise<(string | null)[]> {
  const ids: (string | null)[] = [args.defaultProviderId];
  const choices = await db
    .select({ cliProviderId: schema.taskStepCliChoices.cliProviderId })
    .from(schema.taskStepCliChoices)
    .where(eq(schema.taskStepCliChoices.taskId, args.taskId));
  for (const row of choices) ids.push(row.cliProviderId);
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, args.taskId),
    columns: { summaryCliProviderId: true, ignoreSavedStepClis: true },
  });
  ids.push(task?.summaryCliProviderId ?? null);
  if (task?.ignoreSavedStepClis === false) {
    const inRunList = new Set(args.stepIds);
    const prefs = await db
      .select({
        stepId: schema.userStepCliPreferences.stepId,
        cliProviderId: schema.userStepCliPreferences.cliProviderId,
      })
      .from(schema.userStepCliPreferences)
      .where(
        and(
          eq(schema.userStepCliPreferences.userId, args.userId),
          eq(schema.userStepCliPreferences.explicit, true),
        ),
      );
    const rolePrefs = await db
      .select({
        stepId: schema.userStepCliRolePreferences.stepId,
        cliProviderId: schema.userStepCliRolePreferences.cliProviderId,
      })
      .from(schema.userStepCliRolePreferences)
      .where(
        and(
          eq(schema.userStepCliRolePreferences.userId, args.userId),
          eq(schema.userStepCliRolePreferences.explicit, true),
        ),
      );
    for (const row of [...prefs, ...rolePrefs]) {
      if (inRunList.has(row.stepId)) ids.push(row.cliProviderId);
    }
  }
  return ids;
}

/** Whether a new environment for this task may adopt contract 2: the run list carries the composed steps and one enabled claude-code provider serves every step. */
export async function composedLspAdoptable(
  db: Database,
  args: { taskId: string; userId: string; defaultProviderId: string | null },
): Promise<{ ok: true } | { ok: false; reason: 'run_list' | 'providers' }> {
  const stepIds = await taskRunListStepIds(db, args.taskId);
  if (!stepIds || !composedLspRunListEligible(stepIds)) return { ok: false, reason: 'run_list' };
  const effectiveProviderIds = await collectProviderIds(db, {
    ...args,
    defaultProviderId: args.defaultProviderId,
    stepIds,
  });
  const providers = await db
    .select({
      id: schema.cliProviders.id,
      name: schema.cliProviders.name,
      enabled: schema.cliProviders.enabled,
    })
    .from(schema.cliProviders)
    .where(eq(schema.cliProviders.userId, args.userId));
  return decideComposedLspProviderLock({ effectiveProviderIds, providers }).ok
    ? { ok: true }
    : { ok: false, reason: 'providers' };
}
