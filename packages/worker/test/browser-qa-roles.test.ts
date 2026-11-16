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
const roles = ['haive.browser-verification', 'haive.adversarial-qa'] as const;
const check = { ran: true, passed: true, command: 'check', output: 'ok' };
const outputs = {
  'haive.browser-verification': {
    resultStatus: 'passed',
    ran: true,
    method: 'mcp',
    skipped: false,
    passed: true,
    failures: [],
    visualVerdict: 'STYLED',
    checklistMarkdown: null,
    appUrl: 'http://module',
    appLogin: { attempted: true, ok: true, reason: '' },
    consoleErrors: [],
    networkErrors: [],
  },
  'haive.adversarial-qa': {
    resultStatus: 'clean',
    ran: true,
    level: 'poc',
    blocking: false,
    findings: [],
    counts: { critical: 0, high: 0, total: 0 },
    qaIncomplete: false,
    coverage: null,
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
  put('08-phase-5-verify', { test: check, lint: check, typecheck: check, passed: true });
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

it('gate 2 reads the two bound data producers', async () => {
  const { ctx } = setup();
  const { d, value } = await decision(ctx);
  expect(d.browser?.passed).toBe(true);
  expect(d.adversarial?.counts.total).toBe(0);
  expect(value).toBe('approve');
});
it.each(roles)(
  '%s invalid/contradictory data fails before routing and holds approval',
  async (role) => {
    const { ctx, put } = setup();
    const id = `module.check.${role.split('.').at(-1)}`;
    const invalid = {
      ...outputs[role],
      ...(role === roles[0]
        ? { failures: [{ description: 'broken' }] }
        : { findings: [{ severity: 'high', impact: 'broken' }] }),
    };
    const def = {
      metadata: { id },
      providesRoles: [{ role, contract: { id: role, version: 1 } }],
      fixLoopOnError: true,
    } as unknown as StepDefinition;
    expect(() => validateSuccessfulStepOutput(def, invalid, { warn: vi.fn() })).toThrow(
      'step-output-contract-invalid',
    );
    put(id, invalid, 1);
    expect((await decision(ctx)).value).toBe('reject');
  },
);
it.each(roles)('%s Retry never revives success or borrows a future round', async (role) => {
  const { ctx, put } = setup();
  const id = `module.check.${role.split('.').at(-1)}`;
  put(id, outputs[role], 2);
  put(id, null, 1, 'pending');
  expect(await readRole(ctx, role as never)).toMatchObject({
    state: 'not-ready',
    legacyOutput: null,
  });
  expect((await decision(ctx)).value).toBe('reject');
});
it('manual is never tested passing evidence', async () => {
  const { ctx, put } = setup();
  put(
    'module.check.browser-verification',
    {
      ...outputs[roles[0]],
      resultStatus: 'manual',
      method: 'manual',
      checklistMarkdown: '- [ ] Test',
    },
    1,
  );
  const { d, value } = await decision(ctx);
  expect(d.browser?.method).toBe('manual');
  expect(value).toBe('reject');
});
it('unselected candidates never yield results', async () => {
  const { ctx } = setup(true, 'derived');
  for (const role of roles)
    expect(await readRole(ctx, role as never)).toMatchObject({
      state: 'unselected',
      producer: null,
    });
});
it('explicit absence never borrows matching rows', async () => {
  const { ctx, fake } = setup();
  fake.patch(schema.tasks, ctx.taskId, {
    runListSnapshot: [gate],
    dataEdgePlan: buildDataEdgePlan('static', [
      { executionPath: null, nodes: dataPortNodes([gate]) },
    ]),
  });
  for (const role of roles)
    expect(await readRole(ctx, role as never)).toMatchObject({ state: 'absent', producer: null });
});
