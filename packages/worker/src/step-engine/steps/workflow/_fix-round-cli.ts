import { and, eq } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import { CLI_DISPATCH_STEP_IDS, type FormSchema } from '@haive/shared';
import type { CliProviderRecord } from '../../../cli-adapters/types.js';
import { ProviderBuildError } from '../../../cli-adapters/prompt-delivery.js';
import { resolveDispatch } from '../../../orchestrator/dispatcher.js';
import type { StepDefinition } from '../../step-definition.js';
import { FIX_LOOP_ACTION_FIELD, FIX_LOOP_TARGET_STEP_ID } from './_fix-loop.js';

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
    label: 'Run the next round on',
    description:
      `Applies to ${FIX_LOOP_TARGET_STEP_ID}, round ${options?.round ?? 'next'}, default role: ` +
      'next round only, this task only. Your worktree is kept. Later rounds use your existing CLI choices.',
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
    throw new Error('Next fix round CLI was deleted; choose another CLI before retrying.');
  const provider = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, providerId), eq(schema.cliProviders.userId, userId)),
  });
  if (!provider || provider.userId !== userId)
    throw new Error('Next fix round CLI is not available or owned by you; choose another CLI.');
  if (!provider.enabled)
    throw new Error(
      `Next fix round CLI "${provider.label}" is disabled; enable it before retrying.`,
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
      eq(schema.taskStepCliChoices.role, fixRoundCliRole(round)),
    ),
  });
  return choice ? loadRoundProvider(db, userId, choice.cliProviderId) : undefined;
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
  if (!providerId || providerId === 'same') return;
  const provider = await loadRoundProvider(db, userId, providerId);
  if (eligibleFixRoundProviders(userId, [provider], target).length === 0)
    throw new Error(
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
    .onConflictDoNothing();
}
