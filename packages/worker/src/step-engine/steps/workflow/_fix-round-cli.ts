import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import { CLI_DISPATCH_STEP_IDS } from '@haive/shared';
import {
  checkTaskComposedLspProvider,
  lockTaskForComposedLsp,
} from '@haive/shared/composed-lsp-provider-lock';
import type { CliProviderRecord } from '../../../cli-adapters/types.js';
import { ProviderBuildError } from '../../../cli-adapters/prompt-delivery.js';
import { resolveDispatch } from '../../../orchestrator/dispatcher.js';
import { fixLoopTargetStepId, parseStepId } from '@haive/shared/modularity';
import type { StepDefinition } from '../../step-definition.js';
import {
  FIX_LOOP_TARGET_STEP_ID,
  FIX_ROUND_CLI_FIELD,
  fixRoundCliField,
  fixRoundCliRole,
  type FixRoundCliOptions,
} from './_fix-round-cli-field.js';

export {
  FIX_LOOP_TARGET_STEP_ID,
  FIX_ROUND_CLI_FIELD,
  fixRoundCliField,
  fixRoundCliRole,
  type FixRoundCliOptions,
};

export class FixRoundCliUnavailable extends Error {}

/** A fix-round pick refused because the task is composed-LSP locked; its message is the lock's reason. */
export class FixRoundCliLocked extends FixRoundCliUnavailable {}

const FIX_ROUND_UNAVAILABLE_BODY =
  'The selected CLI is no longer available for the next fix round. Choose another CLI or keep the same CLI, then submit again.';

/** The gate re-park text for a refused pick: the lock's own reason, else the generic sentence. */
export function fixRoundRefusalBody(err: FixRoundCliUnavailable): string {
  return err instanceof FixRoundCliLocked ? err.message : FIX_ROUND_UNAVAILABLE_BODY;
}

/** Use the real dispatcher's capability and command-build checks, with one candidate so
 * an incompatible explicit pick cannot accidentally pass by falling back to another CLI.
 * requiresCli is deliberately irrelevant: 07 has an optional CLI phase and sets it false. */
export function eligibleFixRoundProviders(
  userId: string,
  providers: CliProviderRecord[],
  target: StepDefinition | undefined,
): CliProviderRecord[] {
  if (
    !target?.llm ||
    !(
      CLI_DISPATCH_STEP_IDS.includes(target.metadata.id) ||
      (target.fixConsumer !== undefined && parseStepId(target.metadata.id)?.kind === 'module')
    )
  )
    return [];
  return providers.filter((provider) => {
    if (provider.userId !== userId || !provider.enabled) return false;
    try {
      return (
        resolveDispatch({
          providers: [provider],
          preferredProviderId: provider.id,
          input: {
            kind: 'prompt',
            prompt: 'Fix the reported defect.',
            capabilities: target.llm!.requiredCapabilities,
          },
          toolProfile: target.llm!.toolProfile,
          invokeOpts: { disableTools: target.llm!.disableTools },
        }).mode !== 'skip'
      );
    } catch (err) {
      if (err instanceof ProviderBuildError) return false;
      throw err;
    }
  });
}

/** The fix-round gate's options: eligible providers the task's composed-LSP lock also
 * accepts, so the gate never offers a CLI that `recordFixRoundCliChoice` would refuse. */
export async function fixRoundOptionProviders(
  db: Pick<Database, 'query'>,
  userId: string,
  taskId: string,
  providers: CliProviderRecord[],
  target: StepDefinition | undefined,
): Promise<CliProviderRecord[]> {
  const eligible = eligibleFixRoundProviders(userId, providers, target);
  const allowed: CliProviderRecord[] = [];
  for (const provider of eligible) {
    const lock = await checkTaskComposedLspProvider(db, {
      userId,
      taskId,
      providerId: provider.id,
    });
    if (!lock || lock.ok) allowed.push(provider);
  }
  return allowed;
}

async function loadRoundProvider(
  db: Pick<Database, 'query'>,
  userId: string,
  providerId: string | null,
): Promise<CliProviderRecord> {
  if (!providerId)
    throw new FixRoundCliUnavailable(
      'Next fix round CLI was deleted; choose another CLI on the implementation step card or at the escalation gate.',
    );
  const provider = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, providerId), eq(schema.cliProviders.userId, userId)),
  });
  if (!provider || provider.userId !== userId)
    throw new FixRoundCliUnavailable(
      'Next fix round CLI is not available or owned by you; choose another CLI on the implementation step card or at the escalation gate.',
    );
  if (!provider.enabled)
    throw new FixRoundCliUnavailable(
      `Next fix round CLI "${provider.label}" is disabled; enable it or choose another CLI on the implementation step card.`,
    );
  return provider;
}

export async function resolveFixRoundCli(
  db: Database,
  userId: string,
  taskId: string | undefined,
  stepId: string,
  role: string,
  round: number | undefined,
): Promise<CliProviderRecord | undefined> {
  if (!taskId || role !== 'default' || !round) return;
  if (stepId !== FIX_LOOP_TARGET_STEP_ID && parseStepId(stepId)?.kind !== 'module') return;
  const choice = await db.query.taskStepCliChoices.findFirst({
    where: and(
      eq(schema.taskStepCliChoices.taskId, taskId),
      eq(schema.taskStepCliChoices.stepId, stepId),
      inArray(schema.taskStepCliChoices.role, ['default', fixRoundCliRole(round)]),
    ),
    // Compare in Postgres: Date loses the stored timestamp's sub-millisecond precision.
    // A later card pick (including clearing it) replaces the round override.
    orderBy: [desc(schema.taskStepCliChoices.updatedAt), asc(schema.taskStepCliChoices.role)],
  });
  if (choice?.role !== fixRoundCliRole(round)) return;
  // A round slot is honored only by the task's fix target; the step-card route writes any role on any step.
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { executionContract: true },
  });
  if (fixLoopTargetStepId(task?.executionContract) !== stepId) return;
  return loadRoundProvider(db, userId, choice.cliProviderId);
}

/** Called only inside the gate's existing fenced close/round-transition transaction. */
export async function recordFixRoundCliChoice(
  db: Database | DbTx,
  userId: string,
  taskId: string,
  target: StepDefinition,
  round: number,
  providerId: string | undefined,
): Promise<void> {
  if (!providerId) return;
  if (providerId === 'same') {
    await db
      .delete(schema.taskStepCliChoices)
      .where(
        and(
          eq(schema.taskStepCliChoices.taskId, taskId),
          eq(schema.taskStepCliChoices.stepId, target.metadata.id),
          eq(schema.taskStepCliChoices.role, fixRoundCliRole(round)),
        ),
      );
    return;
  }
  const provider = await loadRoundProvider(db, userId, providerId);
  if (eligibleFixRoundProviders(userId, [provider], target).length === 0)
    throw new FixRoundCliUnavailable(
      `Next fix round CLI "${provider.label}" cannot run ${target.metadata.id}; choose another CLI.`,
    );
  // Lock the task row, then decide: see lockTaskForComposedLsp for the lock order.
  await lockTaskForComposedLsp(db, { userId, taskId });
  const lock = await checkTaskComposedLspProvider(db, { userId, taskId, providerId: provider.id });
  if (lock && !lock.ok) throw new FixRoundCliLocked(lock.message);
  await db
    .insert(schema.taskStepCliChoices)
    .values({
      taskId,
      stepId: target.metadata.id,
      role: fixRoundCliRole(round),
      cliProviderId: provider.id,
      effortLevel: null,
    })
    .onConflictDoUpdate({
      target: [
        schema.taskStepCliChoices.taskId,
        schema.taskStepCliChoices.stepId,
        schema.taskStepCliChoices.role,
      ],
      set: { cliProviderId: provider.id, effortLevel: null, updatedAt: new Date() },
    });
}
