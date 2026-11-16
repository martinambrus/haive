import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { buildDataEdgePlan } from '@haive/shared/data-edge-plan';
import { dataPortNodes } from '@haive/shared/step-ports';
import { gate2VerifyApprovalStep } from '../src/step-engine/steps/workflow/09-gate-2-verify-approval.js';
import { readRole } from '../src/step-engine/read-role.js';
import { validateSuccessfulStepOutput } from '../src/step-engine/step-output-contract.js';
import type { StepContext, StepDefinition } from '../src/step-engine/step-definition.js';
vi.mock('../src/step-engine/steps/env-replicate/_shared.js', async (original) => ({
  ...(await original<object>()),
  getTaskEnvTemplate: async () => null,
}));
vi.mock('../src/step-engine/workspace-probe.js', async (original) => ({
  ...(await original<object>()),
  hasWorkspaceEntry: async () => false,
}));
vi.mock('../src/sandbox/_browser-access.js', async (original) => ({
  ...(await original<object>()),
  resolveTaskDirectAccess: async () => false,
}));
vi.mock('../src/step-engine/steps/workflow/_screenshots.js', async (original) => ({
  ...(await original<object>()),
  resolveScreenshotRoot: async () => '/unused',
  SCREENSHOT_MANIFEST_NAME: 'screenshots.json',
}));
vi.mock('../src/step-engine/steps/workflow/_similar-sites.js', async (original) => ({
  ...(await original<object>()),
  loadTaskSimilarSites: async () => ({ sites: [], omitted: 0 }),
  similarSitesRow: () => null,
}));
vi.mock('../src/step-engine/steps/workflow/_gate-insights.js', async (original) => ({
  ...(await original<object>()),
  INSIGHTS_AT_GATE: 30,
  loadUnactedInsights: async () => ({ insights: [], omitted: 0 }),
  gateInsights: () => [],
  insightsRow: () => null,
}));
vi.mock('../src/step-engine/steps/workflow/_fix-test-store.js', async (original) => ({
  ...(await original<object>()),
  loadFixTestRecords: async () => [],
}));
vi.mock('../src/step-engine/steps/workflow/_gate-house-rules.js', async (original) => ({
  ...(await original<object>()),
  loadGateHouseRules: async () => null,
}));
const gate = '09-gate-2-verify-approval';
const roles = ['haive.validation', 'haive.verify', 'haive.test-management'] as const;
const check = { ran: true, passed: true, command: 'check', output: 'ok' };
const outputs = {
  'haive.validation': {
    resultStatus: 'passed',
    exhaustedBudget: false,
    verdict: 'VALID',
    summary: 'module validation',
    issues: [],
    dimensions: [],
    excludedDimensions: [],
    fixesApplied: [],
    converged: true,
    churnFiles: [],
    report: '',
    validatorPasses: 1,
  },
  'haive.verify': {
    resultStatus: 'passed',
    test: check,
    lint: check,
    typecheck: check,
    passed: true,
    runtimeSmoke: null,
    declinedConfigs: ['nested config'],
    declaredSlots: ['test'],
    offSlots: [],
    slotWithoutRunner: false,
  },
  'haive.test-management': {
    resultStatus: 'passed',
    action: 'module tests',
    testsCreated: ['module.test.ts'],
    testsUpdated: [],
    testsDeleted: [],
    testsPassed: true,
    primary: 'vitest',
  },
};
function setup(pinned = true, selection: 'static' | 'derived' = 'static') {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    reviewFindings: schema.reviewFindings,
  });
  const taskId = randomUUID(),
    taskStepId = randomUUID();
  const entries = new Map(
    roles.map((role) => [
      `module.check.${role.split('.').at(-1)}`,
      { providesRoles: [{ role, contract: { id: role, version: 1 as const } }] },
    ]),
  );
  const ids = [...entries.keys(), gate];
  const nodes = dataPortNodes(ids, {}, entries);
  const plan = buildDataEdgePlan(selection, [
    { executionPath: null, nodes },
    ...(selection === 'derived' ? [{ executionPath: 'full_workflow' as const, nodes }] : []),
  ]);
  fake.insert(schema.tasks, {
    id: taskId,
    dataEdgePlan: pinned ? plan : null,
    runListSnapshot: ids,
    executionPath: selection === 'derived' ? null : 'full_workflow',
  });
  fake.insert(schema.taskSteps, {
    id: taskStepId,
    taskId,
    stepId: gate,
    status: 'running',
    round: 1,
  });
  const put = (stepId: string, output: unknown, round = 0, status = 'done') => {
    const id = randomUUID();
    fake.insert(schema.taskSteps, { id, taskId, stepId, status, round, output, iterations: [] });
    return id;
  };
  for (const role of roles) put(`module.check.${role.split('.').at(-1)}`, outputs[role]);
  const ctx = {
    db: fake.db,
    taskId,
    taskStepId,
    round: 1,
    repoPath: '/unused',
    workspacePath: '/unused',
    userId: randomUUID(),
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as StepContext;
  return { fake, ctx, put, nodes };
}
const decision = async (ctx: StepContext) => {
  const d = await gate2VerifyApprovalStep.detect!(ctx);
  const f = gate2VerifyApprovalStep.form!(ctx, d)!;
  return {
    d,
    f,
    value: (f.fields.find((f) => f.id === 'decision') as { default?: string })?.default,
  };
};
it('gate 2 uses all three bound producers including metadata, without canonical rows', async () => {
  const { ctx } = setup();
  const { d, value } = await decision(ctx);
  expect(d.validation?.summary).toBe('module validation');
  expect(d.testManagement?.line).toContain('module tests');
  expect(d.declaredSlots).toEqual(['test']);
  expect(d.declinedConfigs).toEqual(['nested config']);
  expect(value).toBe('approve');
});
it.each(roles)(
  '%s: invalid producer fails before routing and cannot recommend approval',
  async (role) => {
    const { ctx, put } = setup();
    const id = `module.check.${role.split('.').at(-1)}`;
    const invalid = {
      ...outputs[role],
      resultStatus: 'passed',
      ...(role === roles[0]
        ? { verdict: 'UNPARSEABLE' }
        : role === roles[1]
          ? { passed: false }
          : { testsPassed: null }),
    };
    const def = {
      metadata: { id },
      providesRoles: [{ role, contract: { id: role, version: 1 } }],
    } as unknown as StepDefinition;
    expect(() => validateSuccessfulStepOutput(def, invalid, { warn: vi.fn() })).toThrow(
      'step-output-contract-invalid',
    );
    put(id, invalid, 1);
    expect((await decision(ctx)).value).toBe('reject');
  },
);
it.each(roles)('%s: Retry and future rows never revive old success', async (role) => {
  const { ctx, put } = setup();
  const id = `module.check.${role.split('.').at(-1)}`;
  put(id, outputs[role], 2);
  put(id, null, 1, 'pending');
  expect(await readRole(ctx, role)).toMatchObject({ state: 'not-ready', legacyOutput: null });
  expect((await decision(ctx)).value).toBe('reject');
});
it('unselected candidates do not supply passing evidence', async () => {
  const { ctx } = setup(true, 'derived');
  for (const role of roles)
    expect(await readRole(ctx, role)).toMatchObject({ state: 'unselected', producer: null });
  expect((await decision(ctx)).value).toBe('reject');
});
it.each(roles)(
  '%s: canonical legacy reads do not select a module by output shape',
  async (role) => {
    const { ctx } = setup(false);
    expect(await readRole(ctx, role)).toMatchObject({ state: 'absent' });
  },
);

it('a skipped canonical producer retains only discovery metadata through its pinned input', async () => {
  const { ctx, fake, put } = setup(false);
  const ids = ['08b-test-management', '08-phase-5-verify', gate];
  fake.patch(schema.tasks, ctx.taskId, {
    runListSnapshot: ids,
    dataEdgePlan: buildDataEdgePlan('static', [{ executionPath: null, nodes: dataPortNodes(ids) }]),
  });
  const management = put(ids[0]!, { ...outputs['haive.test-management'] }, 0, 'skipped');
  fake.patch(schema.taskSteps, management, { detectOutput: { primary: 'playwright' } });
  expect(await readRole(ctx, 'haive.test-management')).toMatchObject({
    state: 'not-ready',
    legacyOutput: { primary: 'playwright', resultStatus: 'skipped' },
  });
  expect((await readRole(ctx, 'haive.test-management')).producer).not.toBeNull();
  const verification = put(ids[1]!, outputs['haive.verify'], 0, 'skipped');
  fake.patch(schema.taskSteps, verification, {
    detectOutput: { declinedConfigs: ['nested'], test: null },
  });
  const result = await readRole(ctx, 'haive.verify');
  expect(result).toMatchObject({
    state: 'not-ready',
    legacyOutput: { declinedConfigs: ['nested'], slotWithoutRunner: true, resultStatus: 'skipped' },
  });
  if (result.producer) expect(result.legacyOutput).not.toHaveProperty('passed');
});
