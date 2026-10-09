import { beforeEach, describe, it, expect, vi } from 'vitest';

const m = vi.hoisted(() => ({
  loadPreviousStepOutput: vi.fn(),
  resolveSpecView: vi.fn(),
  loadTaskMeta: vi.fn(),
  loadAppBootOutput: vi.fn(),
  collectImplementationFiles: vi.fn(),
  loadPlanImpactContext: vi.fn(),
  isStepGuidanceEnabled: vi.fn(),
  resolveBrowserRuntime: vi.fn(),
  resolveTaskDirectAccess: vi.fn(),
  ensureAppServing: vi.fn(),
  ensureScreenshotsDir: vi.fn(),
}));

vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput: m.loadPreviousStepOutput,
}));
vi.mock('./_spec-artifact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_spec-artifact.js')>()),
  resolveSpecView: m.resolveSpecView,
}));
vi.mock('./_task-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_task-meta.js')>()),
  loadTaskMeta: m.loadTaskMeta,
  loadAppBootOutput: m.loadAppBootOutput,
}));
vi.mock('./_impl-changes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_impl-changes.js')>()),
  collectImplementationFiles: m.collectImplementationFiles,
}));
vi.mock('./_plan-impact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_plan-impact.js')>()),
  loadPlanImpactContext: m.loadPlanImpactContext,
}));
vi.mock('../../guidance-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../guidance-context.js')>()),
  isStepGuidanceEnabled: m.isStepGuidanceEnabled,
}));
vi.mock('./_browser-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_browser-runtime.js')>()),
  resolveBrowserRuntime: m.resolveBrowserRuntime,
}));
vi.mock('../../../sandbox/_browser-access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/_browser-access.js')>()),
  resolveTaskDirectAccess: m.resolveTaskDirectAccess,
}));
vi.mock('./_app-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_app-runtime.js')>()),
  ensureAppServing: m.ensureAppServing,
}));
vi.mock('./_screenshots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_screenshots.js')>()),
  ensureScreenshotsDir: m.ensureScreenshotsDir,
}));

import { codeSimplifyStep } from './07a-code-simplify.js';
import { browserVerifyStep } from './08a-browser-verify.js';
import { codeAuditStep } from './08c2-code-audit.js';
import { adversarialQaStep } from './08d-adversarial-qa.js';
import { insightsTriageStep } from './08e-insights-triage.js';

const TITLE = 'Fix the login redirect';
const DESCRIPTION = 'After login the user lands on /home instead of the page they asked for.';

// Only what the five detect() functions read of the db: the task's level and DAG mode, and the
// insight outputs 08e collects. Everything else goes through the mocks above.
const db = {
  query: {
    tasks: { findFirst: async () => ({ adversarialQaLevel: 'poc' }) },
    taskDagPlans: { findFirst: async () => undefined },
  },
  select: () => ({
    from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: async () => [] }) }) }),
  }),
};
const ctx = {
  db,
  taskId: 'aaaaaaaa-0000-4000-8000-000000000001',
  repoPath: '/wt',
  workspacePath: '/wt',
  sandboxWorkdir: '/ws',
  logger: { info: vi.fn(), warn: vi.fn() },
  emitProgress: vi.fn(async () => {}),
} as never;

/** detect()'s payload as the runner reads it back; an older detect left a blank spec blank. */
async function persisted(
  step: { detect?: (ctx: never) => Promise<unknown> },
  spec: string,
): Promise<string> {
  m.resolveSpecView.mockResolvedValue({ text: spec, spec, condensed: false });
  const detected = (await step.detect!(ctx)) as object;
  return JSON.stringify(spec.trim() ? detected : { ...detected, spec });
}

/** One dispatch as the runner makes it: the payload read back, `prepare`, then the builder. */
async function dispatch(
  step: { llm?: { prepare?: (args: never) => Promise<void> } },
  payload: string,
  build: (detected: never) => string,
): Promise<string> {
  const detected = JSON.parse(payload) as never;
  await step.llm?.prepare?.({ ctx, detected, formValues: {} } as never);
  return build(detected);
}

/** Every prompt a step builds from a payload persisted with `spec`. */
const STEPS: Array<[string, (spec: string) => Promise<string[]>]> = [
  [
    '07a-code-simplify',
    async (spec) => {
      const payload = await persisted(codeSimplifyStep, spec);
      return [
        await dispatch(codeSimplifyStep, payload, (detected) =>
          codeSimplifyStep.llm!.buildPrompt({ detected, formValues: {} } as never),
        ),
        await dispatch(codeSimplifyStep, payload, (detected) =>
          codeSimplifyStep.loop!.buildIterationPrompt!({
            detected,
            formValues: {},
            iteration: 1,
            previousIterations: [],
          } as never),
        ),
      ];
    },
  ],
  [
    '08a-browser-verify',
    async (spec) => {
      const payload = await persisted(browserVerifyStep, spec);
      return [
        await dispatch(browserVerifyStep, payload, (detected) =>
          browserVerifyStep.llm!.buildPrompt({ detected, formValues: {} } as never),
        ),
        await dispatch(browserVerifyStep, payload, (detected) =>
          browserVerifyStep.loop!.buildIterationPrompt!({
            detected,
            formValues: {},
            iteration: 1,
            previousIterations: [],
          } as never),
        ),
      ];
    },
  ],
  [
    '08c2-code-audit',
    async (spec) => {
      const payload = await persisted(codeAuditStep, spec);
      return [
        await dispatch(codeAuditStep, payload, (detected) =>
          codeAuditStep.llm!.buildPrompt({ detected, formValues: {} } as never),
        ),
      ];
    },
  ],
  [
    '08d-adversarial-qa',
    async (spec) => {
      const detected = JSON.parse(await persisted(adversarialQaStep, spec)) as never;
      const agents = await adversarialQaStep.agentMining!.selectAgents({
        ctx,
        detected,
        formValues: {},
        llmOutput: null,
      });
      return agents.map((a) => a.prompt);
    },
  ],
  [
    '08e-insights-triage',
    async (spec) => {
      const payload = await persisted(insightsTriageStep, spec);
      return [
        await dispatch(insightsTriageStep, payload, (detected) =>
          insightsTriageStep.llm!.buildPrompt({
            detected,
            formValues: { selectedInsights: [] },
          } as never),
        ),
      ];
    },
  ],
];

describe.each(STEPS)('%s: the task brief when a replayed payload has no spec', (_id, prompts) => {
  const task = (title: string, description: string) =>
    m.loadTaskMeta.mockResolvedValue({
      title,
      description,
      feature: null,
      affectedClients: [],
      category: null,
    });

  beforeEach(() => {
    Object.values(m).forEach((fn) => fn.mockReset());
    m.loadPreviousStepOutput.mockImplementation(async (_db: unknown, _id: string, step: string) => {
      if (step === '01-worktree-setup') {
        return {
          detect: null,
          output: { worktreePath: '/wt', sandboxWorktreePath: '/ws' },
          iterations: [],
        };
      }
      if (step === '08a-browser-setup')
        return { detect: null, output: { mode: 'mcp' }, iterations: [] };
      return null;
    });
    m.collectImplementationFiles.mockResolvedValue({
      files: ['src/a.ts'],
      total: 1,
      truncated: false,
      scanError: null,
    });
    m.loadPlanImpactContext.mockResolvedValue(null);
    m.loadAppBootOutput.mockResolvedValue(null);
    m.isStepGuidanceEnabled.mockResolvedValue(false);
    m.resolveTaskDirectAccess.mockResolvedValue(false);
    m.ensureAppServing.mockResolvedValue({ mode: 'none', url: null });
    m.ensureScreenshotsDir.mockResolvedValue(undefined);
    m.resolveBrowserRuntime.mockResolvedValue({
      browserTesting: true,
      available: true,
      skipReason: null,
      ddevMode: false,
      appRunnerMode: false,
      appUrl: 'http://app.test',
      appBooted: true,
      envImageTag: null,
      repoSubpath: null,
      workspace: '/wt',
    });
  });

  it('puts the task title and description in every prompt', async () => {
    task(TITLE, DESCRIPTION);
    const built = await prompts('');
    expect(built.length).toBeGreaterThan(0);
    for (const prompt of built) {
      expect(prompt).toContain(TITLE);
      expect(prompt).toContain(DESCRIPTION);
      expect(prompt).not.toContain('(no spec recorded)');
    }
  });

  it('reads a blank spec as none', async () => {
    task(TITLE, DESCRIPTION);
    for (const prompt of await prompts('   ')) expect(prompt).toContain(DESCRIPTION);
  });

  it('keeps the spec a spec step recorded, and leaves the brief out', async () => {
    task(TITLE, DESCRIPTION);
    const built = await prompts('THE SPEC');
    expect(built.length).toBeGreaterThan(0);
    for (const prompt of built) {
      expect(prompt).toContain('THE SPEC');
      expect(prompt).not.toContain(DESCRIPTION);
    }
  });

  it('says no spec was recorded only when the task has no title or description either', async () => {
    task('  ', '');
    const built = await prompts('');
    expect(built.length).toBeGreaterThan(0);
    for (const prompt of built) expect(prompt).toContain('(no spec recorded)');
  });
});
