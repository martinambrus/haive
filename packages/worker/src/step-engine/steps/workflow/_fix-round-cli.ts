import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import { CLI_DISPATCH_STEP_IDS, FIX_LOOP_ACTION_FIELD, type FormSchema } from '@haive/shared';
import type { CliProviderRecord } from '../../../cli-adapters/types.js';
import { ProviderBuildError } from '../../../cli-adapters/prompt-delivery.js';
import { resolveDispatch } from '../../../orchestrator/dispatcher.js';
import type { StepDefinition } from '../../step-definition.js';
/** The implementation step every fix round re-enters. Kept here so the form builder
 * and dispatch lookup share it without importing the gate/diagnosis module. */
export const FIX_LOOP_TARGET_STEP_ID = '07-phase-2-implement';

export class FixRoundCliUnavailable extends Error {}

export const FIX_ROUND_CLI_FIELD = 'fixRoundCliProviderId';

/** A separate slot leaves the task's ordinary step/seat choices intact. The exact round
 * lookup expires it after that round, while a recovery or Retry of that round keeps it. */
export const fixRoundCliRole = (round: number): string => `fix:${round}:default`;

export interface FixRoundCliOptions {
  round: number;
  providers: Pick<CliProviderRecord, 'id' | 'label'>[];
}

export function fixRoundCliField(options?: FixRoundCliOptions): FormSchema['fields'][number] {
  return {
    type: 'select',
    id: FIX_ROUND_CLI_FIELD,
    label: 'CLI for the next implementation fix',
    description: options?.providers.length
      ? 'Applies only to the implementation step in the next fix round of this task. ' +
        'Your worktree is kept. Later rounds use your existing CLI choices.'
      : 'No enabled CLI is eligible for the next fix round; your existing CLI choice will be used.',
    default: 'same',
    options: [
      { value: 'same', label: 'The same CLI' },
      ...(options?.providers ?? []).map((p) => ({ value: p.id, label: p.label })),
    ],
    visibleWhen: { field: FIX_LOOP_ACTION_FIELD, equals: 'continue' },
  };
}

/** Use the real dispatcher's capability and command-build checks, with one candidate so
 * an incompatible explicit pick cannot accidentally pass by falling back to another CLI.
 * requiresCli is deliberately irrelevant: 07 has an optional CLI phase and sets it false. */
export function eligibleFixRoundProviders(
  userId: string,
  providers: CliProviderRecord[],
  target: StepDefinition | undefined,
): CliProviderRecord[] {
  if (!target?.llm || !CLI_DISPATCH_STEP_IDS.includes(target.metadata.id)) return [];
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
  if (!taskId || stepId !== FIX_LOOP_TARGET_STEP_ID || role !== 'default' || !round) return;
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
  return choice?.role === fixRoundCliRole(round)
    ? loadRoundProvider(db, userId, choice.cliProviderId)
    : undefined;
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
