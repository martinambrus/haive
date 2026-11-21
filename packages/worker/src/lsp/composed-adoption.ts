import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { resolveTaskCliProviderId } from '@haive/shared';
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
  db: Pick<Database, 'query' | 'select'>,
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

/** Whether a new environment for this task may adopt contract 2: the run list carries the composed steps and one enabled claude-code provider serves every step. A null `defaultProviderId` means the task has no own default and is resolved here as the oldest enabled provider. */
export async function composedLspAdoptable(
  db: Pick<Database, 'query' | 'select'>,
  args: { taskId: string; userId: string; defaultProviderId: string | null },
): Promise<{ ok: true } | { ok: false; reason: 'run_list' | 'providers' }> {
  const stepIds = await taskRunListStepIds(db, args.taskId);
  if (!stepIds || !composedLspRunListEligible(stepIds)) return { ok: false, reason: 'run_list' };
  const providers = await db
    .select({
      id: schema.cliProviders.id,
      name: schema.cliProviders.name,
      enabled: schema.cliProviders.enabled,
      createdAt: schema.cliProviders.createdAt,
    })
    .from(schema.cliProviders)
    .where(eq(schema.cliProviders.userId, args.userId));
  const effectiveProviderIds = await collectProviderIds(db, {
    ...args,
    defaultProviderId: resolveTaskCliProviderId(args.defaultProviderId, providers),
    stepIds,
  });
  return decideComposedLspProviderLock({ effectiveProviderIds, providers }).ok
    ? { ok: true }
    : { ok: false, reason: 'providers' };
}

export type ComposedLspReplacementReason =
  'rollout_off' | 'cli_unsupported' | 'selection' | 'run_list' | 'providers';

/** Thrown when a ticked replacement of a legacy environment is refused; the message is for people, match on code and reason. */
export class ComposedLspReplacementRefusedError extends Error {
  readonly code = 'composed_lsp_replacement_refused';
  constructor(readonly reason: ComposedLspReplacementReason) {
    super(
      `composed_lsp_replacement_refused: the legacy environment cannot be replaced (${reason}).`,
    );
    this.name = 'ComposedLspReplacementRefusedError';
  }
}

/** Whether a legacy environment may be replaced by a contract-2 one for this task; read-only. */
export async function decideLegacyLspReplacement(
  db: Pick<Database, 'query' | 'select'>,
  args: {
    taskId: string;
    userId: string;
    defaultProviderId: string | null;
    rolloutOn: boolean;
    cliSupportsLsp: boolean;
    lspServers: readonly string[];
  },
): Promise<{ ok: true } | { ok: false; reason: ComposedLspReplacementReason }> {
  if (!args.rolloutOn) return { ok: false, reason: 'rollout_off' };
  if (!args.cliSupportsLsp) return { ok: false, reason: 'cli_unsupported' };
  if (!isComposedLspSelection(args.lspServers)) return { ok: false, reason: 'selection' };
  return composedLspAdoptable(db, {
    taskId: args.taskId,
    userId: args.userId,
    defaultProviderId: args.defaultProviderId,
  });
}
