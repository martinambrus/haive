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
import {
  guidanceTargetStep,
  parsePromptDefects,
} from '../src/step-engine/steps/workflow/_prompt-defect.js';
import { filterCandidates } from '../src/step-engine/steps/workflow/11e-prompt-guidance.js';
import { loadRoleTaskPin } from '../src/step-engine/role-task-pin.js';

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

for (const [name, executionContract, target] of [
  [
    'custom target',
    { version: 1, guardedSpans: [], fixTarget: { stepId: alternate, capabilityVersion: 1 } },
    alternate,
  ],
  ['legacy', null, single],
  ['inert', { version: 1, guardedSpans: [] }, single],
  ['malformed', { version: 99 }, single],
] as const) {
  it(`physical scope and similar sites follow the ${name}`, async () => {
    const { ctx, fake, put } = setup();
    fake.patch(schema.tasks, ctx.taskId, { executionContract });
    put(single, {
      filesTouched: ['legacy.ts'],
      similarSites: [{ path: 'legacy-site.ts', reason: 'legacy' }],
    });
    put(alternate, {
      filesTouched: ['custom.ts'],
      similarSites: [{ path: 'custom-site.ts', reason: 'custom' }],
    });
    put(target, { filesTouched: ['newest.ts'], similarSites: [] }, 2);
    const files = await collectImplementationFiles(ctx, '/nonexistent-pr7a', { maxRound: 0 });
    expect(files.files).toContain(target === single ? 'legacy.ts' : 'custom.ts');
    expect(files.files).not.toContain(target === single ? 'custom.ts' : 'legacy.ts');
    expect(files.files).not.toContain('newest.ts');
  });

  it(`similar sites follow the ${name}`, async () => {
    const { ctx, fake, put } = setup();
    fake.patch(schema.tasks, ctx.taskId, { executionContract });
    put(single, { similarSites: [{ path: 'legacy-site.ts', reason: 'legacy' }] });
    put(alternate, { similarSites: [{ path: 'custom-site.ts', reason: 'custom' }] });
    expect((await loadTaskSimilarSites(ctx.db, ctx.taskId)).sites).toEqual([
      {
        path: target === single ? 'legacy-site.ts' : 'custom-site.ts',
        reason: target === single ? 'legacy' : 'custom',
        source: 'implementation round 0',
      },
    ]);
  });

  it(`guidance target and fingerprints follow the ${name}`, async () => {
    const { ctx, fake } = setup();
    fake.patch(schema.tasks, ctx.taskId, { executionContract });
    const task = await loadRoleTaskPin(ctx.db, ctx.taskId);
    const raw = '## PROMPT-DEFECT\n- DEFECT: missing_context | State the invariant | src/a.ts:1';
    for (const sourceStep of [
      '07b-phase-4-validate',
      '08a-browser-verify',
      '08d-adversarial-qa',
      '08c-code-review',
    ]) {
      expect(guidanceTargetStep(sourceStep, task)).toBe(target);
      const defects = parsePromptDefects([{ stepId: sourceStep, raw }], task);
      expect(defects[0]?.fingerprint).toMatch(new RegExp(`^${target}:`));
      expect(filterCandidates(defects, [], task)[0]?.targetStep).toBe(target);
    }
    expect(guidanceTargetStep('unknown', task)).toBeNull();
  });
}
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

it.each(['workflow', 'derived-demo'])(
  '%s: learning verification values retain bytes through a bound module result',
  async (type) => {
    const verifyRole = 'haive.verify' as const;
    const moduleId = 'module.example.verify';
    const { ctx, put, fake } = setup([single, moduleId, learning], false, type);
    const check = { ran: true, passed: true, command: 'test', output: 'ok' };
    const value = {
      resultStatus: 'passed',
      passed: true,
      test: check,
      lint: check,
      typecheck: check,
      runtimeSmoke: null,
      declinedConfigs: [],
      declaredSlots: [],
      offSlots: [],
      slotWithoutRunner: false,
    };
    put(single, output);
    put('08-phase-5-verify', value);
    const before = await phase8LearningStep.detect!(ctx);
    const nodes = dataPortNodes(
      [single, moduleId, learning],
      {},
      new Map([
        [
          moduleId,
          { providesRoles: [{ role: verifyRole, contract: { id: verifyRole, version: 1 } }] },
        ],
      ]),
    );
    const selection = type === 'workflow' ? 'static' : 'derived';
    fake.patch(schema.tasks, ctx.taskId, {
      executionPath: 'full_workflow',
      dataEdgePlan: buildDataEdgePlan(selection, [
        { executionPath: null, nodes },
        ...(selection === 'derived' ? [{ executionPath: 'full_workflow' as const, nodes }] : []),
      ]),
    });
    put(moduleId, value);
    const after = await phase8LearningStep.detect!(ctx);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    put(moduleId, { ...value, resultStatus: 'not-run' }, 1);
    expect((await phase8LearningStep.detect!(ctx)).verifyPassed).toBe(false);
  },
);

it('a module target with no summary keys keeps git scope and DAG similar-site reports', async () => {
  const { ctx, fake, put } = setup();
  fake.patch(schema.tasks, ctx.taskId, {
    executionContract: {
      version: 1,
      guardedSpans: [],
      fixTarget: { stepId: alternate, capabilityVersion: 1 },
    },
  });
  put(alternate, {});
  fake.insert(schema.taskDagIssues, {
    taskId: ctx.taskId,
    issueKey: 'ISSUE-1',
    level: 0,
    similarSites: [{ path: 'other.ts', reason: 'same defect' }],
  });
  const files = await collectImplementationFiles(ctx, '/nonexistent-module-summary');
  expect(files.files).toContain('src/measured.ts');
  expect((await loadTaskSimilarSites(ctx.db, ctx.taskId)).sites).toEqual([
    { path: 'other.ts', reason: 'same defect', source: 'DAG issue ISSUE-1' },
  ]);
});

it.each([
  ['number', 42, []],
  ['object', { path: 'invalid.ts' }, []],
  ['string', 'invalid.ts', []],
  ['mixed array', [null, 42, { path: 'invalid.ts' }, true, 'reported.ts'], ['reported.ts']],
] as const)(
  'a module target tolerates %s filesTouched and retains only string array items',
  async (_name, filesTouched, reported) => {
    const { ctx, fake, put } = setup();
    fake.patch(schema.tasks, ctx.taskId, {
      executionContract: {
        version: 1,
        guardedSpans: [],
        fixTarget: { stepId: alternate, capabilityVersion: 1 },
      },
    });
    put(alternate, { filesTouched });
    const result = await collectImplementationFiles(ctx, '/unused');
    expect(result.files).toEqual([...reported, 'src/measured.ts']);
  },
);
