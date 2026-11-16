import {
  safeParseStepOutput,
  IMPLEMENTATION_SUMMARY_OUTPUT_CONTRACT,
} from '@haive/shared/step-outputs';
import { phase2ImplementStep } from '../src/step-engine/steps/workflow/07-phase-2-implement.js';
import { dagExecuteStep } from '../src/step-engine/steps/workflow/06c-dag-execute.js';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { buildDataEdgePlan } from '@haive/shared/data-edge-plan';
import { dataPortNodes } from '@haive/shared/step-ports';
import { phase8LearningStep } from '../src/step-engine/steps/workflow/11-phase-8-learning.js';
import { readRole, legacyRoleOutput } from '../src/step-engine/read-role.js';
import { loadPreviousStepOutput } from '../src/step-engine/steps/onboarding/_helpers.js';
import { collectImplementationFiles } from '../src/step-engine/steps/workflow/_impl-changes.js';
import { loadTaskSimilarSites } from '../src/step-engine/steps/workflow/_similar-sites.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

vi.mock('../src/step-engine/task-ledger.js', () => ({ recordLedgerEntry: async () => {} }));
vi.mock('../src/repo/git-exec.js', () => ({
  gitExec: async (args: string[]) => ({
    stdout: args.includes('status') ? ' M src/measured.ts\0' : '',
    stderr: '',
  }),
  gitRun: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
}));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<object>()),
  readdirNoFollow: async () => null,
  readTextNoFollow: async () => null,
  lstatNoFollow: async () => null,
}));
vi.mock('../src/repo/git-workspace.js', () => ({ gitWorkspaceStatus: async () => 'none' }));
vi.mock('../src/step-engine/steps/workflow/_task-history-digest.js', () => ({
  buildTaskHistoryDigest: async () => ({
    text: '',
    tier: 'low',
    maxRound: 0,
    fixLoopCount: 0,
    findingCount: 0,
    steerCount: 0,
  }),
}));
vi.mock('../src/step-engine/steps/_global-kb-promote.js', async (original) => ({
  ...(await original<object>()),
  loadActiveGlobalArticlesForTask: async () => ({
    articles: [],
    otherTitles: [],
    otherDescriptions: [],
    omittedTitleCount: 0,
  }),
}));
vi.mock('../src/step-engine/steps/workflow/_learning-feedback.js', async (original) => ({
  ...(await original<object>()),
  loadOutstandingLearningInstruction: async () => '',
}));
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', async (original) => ({
  ...(await original<object>()),
  resolveTaskSkillTargetDirs: async () => [],
}));
const role = 'haive.implementation.summary' as const;
const single = '07-phase-2-implement';
const dag = '06c-dag-execute';
const learning = '11-phase-8-learning';
const alternate = 'module.example.summary';
const output = {
  summary: 'Implemented rentals.\nExact bytes.',
  filesTouched: ['src/rental.ts'],
  similarSites: [{ path: 'src/other.ts', reason: 'same defect' }],
};
function setup(ids = [single, learning], pinned = false, type = 'workflow') {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    taskDagIssues: schema.taskDagIssues,
    taskDagPlans: schema.taskDagPlans,
    repositories: schema.repositories,
  });
  const taskId = randomUUID();
  const taskStepId = randomUUID();
  const nodes = pinned
    ? dataPortNodes(
        ids,
        {},
        new Map([[alternate, { providesRoles: [{ role, contract: { id: role, version: 1 } }] }]]),
      )
    : [];
  fake.insert(schema.tasks, {
    id: taskId,
    type,
    title: 'Add rentals',
    description: 'A capability',
    metadata: {},
    repositoryId: null,
    runListSnapshot: ids,
    dataEdgePlan: pinned ? buildDataEdgePlan('static', [{ executionPath: null, nodes }]) : null,
  });
  fake.insert(schema.taskSteps, {
    id: taskStepId,
    taskId,
    stepId: learning,
    round: 1,
    status: 'running',
  });
  const ctx = {
    db: fake.db,
    taskId,
    taskStepId,
    round: 1,
    workspacePath: '/unused',
    repoPath: '/unused',
    userId: randomUUID(),
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as StepContext;
  const put = (stepId: string, value: unknown, round = 0, status = 'done') => {
    const id = randomUUID();
    fake.insert(schema.taskSteps, {
      id,
      taskId,
      stepId,
      round,
      status,
      output: value,
      iterations: [],
    });
    return id;
  };
  return { fake, ctx, put };
}
const cases = ['single', 'dag', 'absent', 'fix round', 'retry'] as const;
for (const mode of ['builtin', 'derived'] as const)
  it.each(cases)(`${mode} learning bytes: %s`, async (name) => {
    const { ctx, put, fake } = setup(
      name === 'dag' ? [dag, single, learning] : [single, learning],
      false,
      mode === 'builtin' ? 'workflow' : 'derived-demo',
    );
    if (name !== 'absent')
      put(single, name === 'dag' ? null : output, 0, name === 'dag' ? 'skipped' : 'done');
    if (name === 'fix round') put(single, { ...output, summary: 'Fixed the regression' }, 1);
    if (name === 'retry') put(single, null, 1, 'pending');
    const detected = await phase8LearningStep.detect!(ctx);
    // Frozen pre-role physical read; no role resolver in the oracle.
    const row = await loadPreviousStepOutput(ctx.db, ctx.taskId, single);
    const old = (row?.output ?? {}) as typeof output;
    expect({
      implementSummary: detected.implementSummary,
      filesTouched: detected.filesTouched,
    }).toEqual({
      implementSummary: old.summary ?? '',
      filesTouched: Array.isArray(old.filesTouched) ? old.filesTouched : [],
    });
    expect(
      JSON.stringify({
        values: detected,
        prompt: phase8LearningStep.llm!.buildPrompt({ detected, formValues: {} }),
      }),
    ).toMatchSnapshot();
    const ids = name === 'dag' ? [dag, single, learning] : [single, learning];
    const nodes = dataPortNodes(ids);
    const selection = mode === 'derived' ? 'derived' : 'workflow';
    const candidates = [
      { executionPath: null, nodes },
      { executionPath: 'full_workflow' as const, nodes },
    ];
    fake.patch(schema.tasks, ctx.taskId, {
      dataEdgePlan: buildDataEdgePlan(selection, candidates),
      executionPath: 'full_workflow',
    });
    const pinned = await phase8LearningStep.detect!(ctx);
    expect(JSON.stringify(pinned)).toBe(JSON.stringify(detected));
    expect(phase8LearningStep.llm!.buildPrompt({ detected: pinned, formValues: {} })).toBe(
      phase8LearningStep.llm!.buildPrompt({ detected, formValues: {} }),
    );
  });
it('learning honors its immutable module input instead of the physical implementation', async () => {
  const { ctx, put } = setup([alternate, learning], true);
  put(single, output);
  put(alternate, { ...output, summary: 'Module summary', filesTouched: ['module-only.ts'] });
  expect(await phase8LearningStep.detect!(ctx)).toMatchObject({
    implementSummary: 'Module summary',
    filesTouched: ['module-only.ts'],
  });
});
it('v3 reads the newest row below the consumer ceiling and never an older success after Retry', async () => {
  const { ctx, put, fake } = setup([single, learning], true);
  put(single, output);
  const id = put(single, { ...output, summary: 'Fix' }, 1);
  put(single, { ...output, summary: 'Future' }, 2);
  expect(legacyRoleOutput(await readRole(ctx, role))).toMatchObject({ summary: 'Fix' });
  fake.patch(schema.taskSteps, id, { status: 'pending', output: null });
  expect(await readRole(ctx, role)).toMatchObject({
    state: 'not-ready',
    legacyOutput: null,
  });
});
it('DAG-only normalization keeps the historical empty learning values', async () => {
  const { ctx, put } = setup([dag, learning], true);
  put(dag, { ran: true, issues: 5, levels: 2 });
  // Matching keys in unrelated output may not become a producer.
  put('module.example.unbound', output);
  expect(await readRole(ctx, role)).toMatchObject({
    state: 'ready',
    data: { summary: '', filesTouched: [] },
    producer: { stepId: dag },
  });
  expect(await phase8LearningStep.detect!(ctx)).toMatchObject({
    implementSummary: '',
    filesTouched: [],
  });
});
it('a module binding cannot alter physical review scope or the historical similar-sites inventory', async () => {
  const { ctx, put, fake } = setup([alternate, learning], false);
  put(single, output);
  put(single, { ...output, filesTouched: ['src/other.ts'], similarSites: [] }, 1);
  put(alternate, {
    summary: 'Poison',
    filesTouched: ['poison.ts'],
    similarSites: [{ path: 'poison.ts', reason: 'poison' }],
  });
  const collect = async () =>
    JSON.stringify({
      files: await collectImplementationFiles(ctx, '/nonexistent-prt5b'),
      sites: await loadTaskSimilarSites(ctx.db, ctx.taskId),
    });
  const before = await collect();
  const nodes = dataPortNodes(
    [alternate, learning],
    {},
    new Map([[alternate, { providesRoles: [{ role, contract: { id: role, version: 1 } }] }]]),
  );
  fake.patch(schema.tasks, ctx.taskId, {
    dataEdgePlan: buildDataEdgePlan('static', [{ executionPath: null, nodes }]),
  });
  expect(await collect()).toBe(before);
  expect(before).toContain('src/other.ts');
  expect(before).toContain('src/measured.ts');
  expect(before).not.toContain('poison.ts');
});

it('old valid v3 pins read canonically while explicit absence and malformed pins never remap', async () => {
  const { ctx, put, fake } = setup([single, learning]);
  put(single, output);
  const nodes = dataPortNodes([single, learning]).map((n) => ({
    ...n,
    inputs: n.inputs.filter((i) => i.role !== role),
    outputs: n.outputs.filter((o) => o.role !== role),
  }));
  fake.patch(schema.tasks, ctx.taskId, {
    dataEdgePlan: buildDataEdgePlan('static', [{ executionPath: null, nodes }]),
  });
  expect(await phase8LearningStep.detect!(ctx)).toMatchObject({
    implementSummary: output.summary,
    filesTouched: output.filesTouched,
  });
  fake.patch(schema.tasks, ctx.taskId, {
    dataEdgePlan: buildDataEdgePlan('static', [
      { executionPath: null, nodes: dataPortNodes([learning]) },
    ]),
    runListSnapshot: [learning],
  });
  expect(await phase8LearningStep.detect!(ctx)).toMatchObject({
    implementSummary: '',
    filesTouched: [],
  });
  fake.patch(schema.tasks, ctx.taskId, { dataEdgePlan: { version: 4 } });
  await expect(phase8LearningStep.detect!(ctx)).rejects.toThrow('invalid-data-edge-plan');
});
it('refuses a pinned unknown contract without falling back to 07', async () => {
  const { ctx, put, fake } = setup([single, learning]);
  put(single, output);
  const nodes = dataPortNodes([single, learning]).map((n) => ({
    ...n,
    inputs: n.inputs.map((i) =>
      i.role === role ? { ...i, contract: { id: role, version: 2 } } : i,
    ),
    outputs: n.outputs.map((o) =>
      o.role === role ? { ...o, contract: { id: role, version: 2 } } : o,
    ),
  }));
  fake.patch(schema.tasks, ctx.taskId, {
    dataEdgePlan: buildDataEdgePlan('static', [{ executionPath: null, nodes }]),
  });
  await expect(phase8LearningStep.detect!(ctx)).rejects.toThrow('pinned contract unavailable');
});

it.each([output, 'Agent prose only', { files: ['src/a.ts'] }, null])(
  'validates every real 07 apply path: %j',
  async (llmOutput) => {
    const { ctx } = setup();
    const result = await phase2ImplementStep.apply(ctx, {
      detected: { gateFeedback: 'operator' } as never,
      formValues: {},
      llmOutput,
      iteration: 0,
      previousIterations: [],
    });
    expect(safeParseStepOutput(IMPLEMENTATION_SUMMARY_OUTPUT_CONTRACT, result).success).toBe(true);
    if (llmOutput === output) expect(result).toMatchObject(output);
    if (llmOutput === null)
      expect(result).toMatchObject({ source: 'stub', filesTouched: [], similarSites: [] });
  },
);
it('validates the actual DAG apply host summary without borrowing issue claims', async () => {
  const { ctx } = setup([dag, learning]);
  const result = await dagExecuteStep.apply(ctx, {
    detected: { mode: 'dag', issueCount: 3, levelCount: 2 },
    formValues: {},
    iteration: 0,
    previousIterations: [],
  });
  expect(safeParseStepOutput(IMPLEMENTATION_SUMMARY_OUTPUT_CONTRACT, result).success).toBe(true);
  expect(result).toMatchObject({ summary: '', filesTouched: [], ran: true, issues: 3, levels: 2 });
});
