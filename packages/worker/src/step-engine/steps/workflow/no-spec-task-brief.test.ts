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

/** The step's own detect(), then every prompt it builds from that payload. */
const STEPS: Array<[string, () => Promise<string[]>]> = [
  [
    '07a-code-simplify',
    async () => {
      const detected = await codeSimplifyStep.detect!(ctx);
      return [
        codeSimplifyStep.llm!.buildPrompt({ detected, formValues: {} } as never),
        codeSimplifyStep.loop!.buildIterationPrompt!({
          detected,
          formValues: {},
          iteration: 1,
          previousIterations: [],
        } as never),
      ];
    },
  ],
  [
    '08a-browser-verify',
    async () => {
      const detected = await browserVerifyStep.detect!(ctx);
      return [
        browserVerifyStep.llm!.buildPrompt({ detected, formValues: {} } as never),
        browserVerifyStep.loop!.buildIterationPrompt!({
          detected,
          formValues: {},
          iteration: 1,
          previousIterations: [],
        } as never),
      ];
    },
  ],
  [
    '08c2-code-audit',
    async () => {
      const detected = await codeAuditStep.detect!(ctx);
      return [codeAuditStep.llm!.buildPrompt({ detected, formValues: {} } as never)];
    },
  ],
  [
    '08d-adversarial-qa',
    async () => {
      const detected = await adversarialQaStep.detect!(ctx);
      const agents = await adversarialQaStep.agentMining!.selectAgents({ detected } as never);
      return agents.map((a) => a.prompt);
    },
  ],
  [
    '08e-insights-triage',
    async () => {
      const detected = await insightsTriageStep.detect!(ctx);
      return [
        insightsTriageStep.llm!.buildPrompt({
          detected,
          formValues: { selectedInsights: [] },
        } as never),
      ];
    },
  ],
];

describe.each(STEPS)('%s: the task brief when there is no spec', (_id, prompts) => {
  const spec = (text: string) =>
    m.resolveSpecView.mockResolvedValue({ text, spec: text, condensed: false });
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
    spec('');
    task(TITLE, DESCRIPTION);
    const built = await prompts();
    expect(built.length).toBeGreaterThan(0);
    for (const prompt of built) {
      expect(prompt).toContain(TITLE);
      expect(prompt).toContain(DESCRIPTION);
      expect(prompt).not.toContain('(no spec recorded)');
    }
  });

  it('reads a blank spec as none', async () => {
    spec('   ');
    task(TITLE, DESCRIPTION);
    for (const prompt of await prompts()) expect(prompt).toContain(DESCRIPTION);
  });

  it('keeps the spec a spec step recorded, and leaves the brief out', async () => {
    spec('THE SPEC');
    task(TITLE, DESCRIPTION);
    const built = await prompts();
    expect(built.length).toBeGreaterThan(0);
    for (const prompt of built) {
      expect(prompt).toContain('THE SPEC');
      expect(prompt).not.toContain(DESCRIPTION);
    }
  });

  it('says no spec was recorded only when the task has no title or description either', async () => {
    spec('');
    task('  ', '');
    const built = await prompts();
    expect(built.length).toBeGreaterThan(0);
    for (const prompt of built) expect(prompt).toContain('(no spec recorded)');
  });
});
