import { CODE_AUDIT_OUTPUT_CONTRACT } from '@haive/shared/step-outputs';
import type { CodeAuditOutput } from '@haive/shared/step';
import {
  AdvisedStepError,
  MiningRetryError,
  MiningWaveError,
  PromptBudgetExceededError,
  ReopenStepFormError,
  RetryableParseError,
  TaskCancelledError,
  StepPrepareParkError,
  type ChatPlanRead,
  type StepDefinition,
} from '@haive/shared/step';

// The compiled module exposes the constructors it actually resolved, for the host's identity check.
export const errors = {
  AdvisedStepError,
  MiningRetryError,
  MiningWaveError,
  PromptBudgetExceededError,
  ReopenStepFormError,
  RetryableParseError,
  TaskCancelledError,
  StepPrepareParkError,
};

const snapshot: ChatPlanRead = { nodes: [], edges: [] };

const step = {
  attachmentContext: 'none',
  metadata: {
    id: 'report',
    workflowType: 'fixture',
    index: 0,
    title: 'Report',
    description: 'SDK fixture',
    requiresCli: false,
  },
  async detect() {
    return { path: 'src/example.ts' };
  },
  form() {
    return { title: 'Report', fields: [] };
  },
  llm: {
    requiredCapabilities: [],
    buildPrompt: () => 'Return a report.',
    planSnapshot: () => snapshot,
    retry: { maxAttempts: 2, retryOn: (error: unknown) => error instanceof RetryableParseError },
  },
  loop: {
    maxIterations: 2,
    shouldContinue: ({ applyOutput }) => applyOutput.report.length === 0,
  },
  async apply(ctx, { detected, formValues }) {
    ctx.throwIfCancelled();
    switch (formValues['signal']) {
      case 'cancel':
        throw new TaskCancelledError();
      case 'advice':
        throw new AdvisedStepError('Failed', 'Diagnosis', 'Advice');
      case 'parse':
        throw new RetryableParseError('Invalid report');
      case 'retry':
        throw new MiningRetryError(['reviewer']);
      case 'wave':
        throw new MiningWaveError([{ agentId: 'reviewer', agentTitle: null, prompt: 'Review' }]);
      case 'reopen':
        throw new ReopenStepFormError('Next batch', { notice: true });
    }
    return { report: detected.path };
  },
} satisfies StepDefinition<{ path: string }, { report: string }>;

export default [step] as const;

// A real module checks the optional port once, then uses only the public DTOs.
export async function reviewWithHost(ctx: import('@haive/shared/step').StepContext) {
  const host = ctx.host;
  if (!host) throw new Error('This module requires step host services.');
  const previous = await host.loadPreviousStepOutput('01-worktree-setup');
  const output = previous?.output;
  if (
    !output ||
    typeof output !== 'object' ||
    !('worktreePath' in output) ||
    typeof output.worktreePath !== 'string'
  )
    throw new Error('The worktree output is unavailable.');
  const worktreePath = output.worktreePath;
  const scope = await host.collectImplementationFiles(worktreePath);
  const review = await host.readReviewDiff({
    worktreePath,
    maxBytes: 4096,
    includeFileContents: true,
  });
  const options: import('@haive/shared/step').InsightLoadOptions = { includePicked: true };
  const inventory: import('@haive/shared/step').InsightLoadResult =
    await host.loadUnactedInsights(options);
  const records: import('@haive/shared/step').LoadedInsight[] = inventory.insights;
  const refs: import('@haive/shared/step').InsightSourceRef[] = records.flatMap(
    (i) => i.sourceRefs ?? [],
  );
  const role: import('@haive/shared/step').ModuleRoleRead = await host.loadRoleOutput('spec');
  return { scope, review, inventory, refs, role };
}

// A real compiled consumer of the host contract and its inferred SDK output type.
export const contractedAudit = {
  metadata: {
    id: 'audit',
    title: 'Audit',
    description: 'Contract fixture',
    index: 1,
    workflowType: 'fixture',
    requiresCli: false,
  },
  outputContract: CODE_AUDIT_OUTPUT_CONTRACT,
  replaces: ['08c2-code-audit'],
  async apply() {
    return { audited: true, findings: [{ severity: 'low', issue: 'observation' }], coverage: null };
  },
} satisfies StepDefinition<unknown, CodeAuditOutput>;

// A fix consumer reads the task-bound request the host recorded for its round; FixLoopRead says
// which fields it fences itself.
export async function readFixRequest(ctx: import('@haive/shared/step').StepContext) {
  const host = ctx.host;
  if (!host) throw new Error('This module requires step host services.');
  const read: import('@haive/shared/step').FixLoopRead | null = await host.loadFixLoopDiagnosis();
  if (!read) return null;
  const repeat: import('@haive/shared/step').FixLoopRepeat | null = read.repeat;
  return { diagnosis: read.diagnosis, guidance: read.guidance, repeat, prior: read.prior };
}
