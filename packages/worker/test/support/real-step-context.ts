import type { Database } from '@haive/database';
import { willSkipBeforeAdmission } from '../../src/step-engine/step-runner.js';
import type { StepContext, StepDefinition } from '../../src/step-engine/step-definition.js';

export interface ProviderFixture {
  id: string;
  enabled: boolean;
  createdAt: Date;
  name?: string;
  [key: string]: unknown;
}

export interface RealStepContextOptions {
  cliProviderId: string | null;
  providers?: readonly ProviderFixture[];
  db?: Database;
  userId?: string;
  taskId?: string;
  repoPath?: string;
  workspacePath?: string;
}

const PROBE = {
  metadata: { id: 'real-step-context', workflowType: 'workflow', index: 0, title: 'probe' },
} as unknown as StepDefinition;

/** Whether the real pre-admission gate skips `stepDef` for this task, and the ctx the real
 *  `buildStepContext` handed its `shouldRun` (the only public door to that builder). */
export async function realSkipDecision(
  opts: RealStepContextOptions,
  stepDef: StepDefinition = PROBE,
): Promise<{ skipped: boolean; ctx: StepContext }> {
  let seen: StepContext | null = null;
  const wrapped = {
    ...stepDef,
    shouldRun: async (ctx: StepContext) => {
      seen = ctx;
      return stepDef.shouldRun ? stepDef.shouldRun(ctx) : true;
    },
  } as StepDefinition;
  const params = {
    db: opts.db ?? ({} as Database),
    taskId: opts.taskId ?? 'task-1',
    userId: opts.userId ?? 'user-1',
    repoPath: opts.repoPath ?? '/repo',
    workspacePath: opts.workspacePath ?? '/repo',
    cliProviderId: opts.cliProviderId,
    stepDef: wrapped,
    providers: opts.providers,
  };
  const skipped = await willSkipBeforeAdmission(params as never, { id: 'row-1' } as never);
  if (!seen) throw new Error('shouldRun was not reached');
  return { skipped, ctx: seen };
}

export async function realStepContext(opts: RealStepContextOptions): Promise<StepContext> {
  return (await realSkipDecision(opts)).ctx;
}
