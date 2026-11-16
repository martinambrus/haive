import { configService } from '@haive/shared';
import { adversarialQaStep } from '../src/step-engine/steps/workflow/08d-adversarial-qa.js';
import { adversarialQaReviewStep } from '../src/step-engine/steps/workflow/08d2-adversarial-qa-review.js';
import {
  findingFingerprint,
  loadFindingRecurrence,
} from '../src/step-engine/steps/workflow/_review-findings.js';
import { renderTaskHistoryDigest } from '../src/step-engine/steps/workflow/_task-history-digest.js';
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
vi.mock('../src/step-engine/steps/workflow/_impl-changes.js', async (original) => ({
  ...(await original<object>()),
  collectImplementationFiles: async () => ({
    files: ['a.ts'],
    total: 1,
    truncated: false,
    scanError: null,
  }),
}));
vi.mock('../src/step-engine/steps/workflow/_spec-artifact.js', async (original) => ({
  ...(await original<object>()),
  resolveSpecView: async () => ({ text: '' }),
}));
vi.mock('../src/step-engine/guidance-context.js', async (original) => ({
  ...(await original<object>()),
  isStepGuidanceEnabled: async () => false,
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
    taskDagPlans: schema.taskDagPlans,
  });
  const taskId = randomUUID(),
    taskStepId = randomUUID();
  const entries = new Map(
    roles.map((role) => [
      `module.check.${role.split('.').at(-1)}`,
      { providesRoles: [{ role, contract: { id: role, version: 1 as const } }] },
    ]),
  );
  const ids = ['08-phase-5-verify', ...entries.keys(), gate];
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
  expect(await readRole(ctx, role)).toMatchObject({
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
    expect(await readRole(ctx, role)).toMatchObject({
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
    expect(await readRole(ctx, role)).toMatchObject({ state: 'absent', producer: null });
});

it('bound QA retains every merged fingerprint, waiver fence and recurrence round', async () => {
  const { ctx, put, fake } = setup();
  const fp1 = findingFingerprint('bandit', 'a.ts', 'bypass');
  const fp2 = findingFingerprint('infector', 'a.ts', 'bypass');
  const foreignFp = findingFingerprint('unrelated', 'other.ts', 'other finding');
  const finding = {
    severity: 'high',
    category: 'auth',
    location: 'a.ts:1',
    impact: 'bypass',
    verification: 'not_reproduced',
    fingerprints: [fp1, fp2, foreignFp],
  };
  const out = {
    ...outputs[roles[1]],
    resultStatus: 'findings',
    findings: [finding],
    counts: { critical: 0, high: 1, total: 1 },
  };
  const qaRow = put('module.check.adversarial-qa', out, 1);
  // Attach the real QA-review consumer to its own immutable input, not the gate-2 node.
  const ids = ['module.check.adversarial-qa', '08d2-adversarial-qa-review'];
  const entries = new Map([
    [
      ids[0]!,
      { providesRoles: [{ role: roles[1], contract: { id: roles[1], version: 1 as const } }] },
    ],
  ]);
  fake.patch(schema.tasks, ctx.taskId, {
    dataEdgePlan: buildDataEdgePlan('static', [
      { executionPath: null, nodes: dataPortNodes(ids, {}, entries) },
    ]),
    runListSnapshot: ids,
  });
  fake.patch(schema.taskSteps, ctx.taskStepId, { stepId: ids[1] });
  for (const round of [0, 1])
    for (const [fingerprint, reviewerId] of [
      [fp1, 'bandit'],
      [fp2, 'infector'],
    ])
      fake.insert(schema.reviewFindings, {
        id: randomUUID(),
        taskId: ctx.taskId,
        taskStepId: round === 1 ? qaRow : randomUUID(),
        round,
        fingerprint,
        reviewerId,
        path: 'a.ts',
        disposition: 'open',
      });
  fake.insert(schema.reviewFindings, {
    id: randomUUID(),
    taskId: ctx.taskId,
    taskStepId: randomUUID(),
    round: 1,
    fingerprint: foreignFp,
    reviewerId: 'unrelated',
    path: 'other.ts',
    disposition: 'open',
  });
  const recurrence = await loadFindingRecurrence(ctx, 1);
  expect([...recurrence.values()]).toEqual([[0], [0]]);
  expect(await adversarialQaReviewStep.shouldRun!(ctx)).toBe(true);
  const detected = await adversarialQaReviewStep.detect!(ctx);
  expect(detected.findings[0]?.fingerprints).toEqual([fp1, fp2]);
  expect(detected.findings[0]?.label).toContain('[NOT REPRO]');
  const result = await adversarialQaReviewStep.apply!(ctx, {
    detected,
    iteration: 0,
    previousIterations: [],
    formValues: {
      decision: 'fix',
      scope: 'selected',
      findingKeys: [],
      feedback: 'Review separately',
    },
  });
  expect(result).toMatchObject({ waivedCount: 1, selectedCount: 0 });
  const rows = fake.rows(schema.reviewFindings);
  expect(rows.filter((r) => r.round === 0).map((r) => r.disposition)).toEqual(['open', 'open']);
  expect(
    rows.filter((r) => r.round === 1 && r.taskStepId === qaRow).map((r) => r.disposition),
  ).toEqual(['dismissed_human', 'dismissed_human']);
  expect(rows.find((r) => r.fingerprint === foreignFp)?.disposition).toBe('open');
  expect(await loadFindingRecurrence(ctx, 1)).toEqual(recurrence);
  expect((await adversarialQaReviewStep.detect!(ctx)).findings).toEqual(detected.findings);
});
it('digest mines every bound browser/QA round with canonical bytes and excludes unbound canonical rows', () => {
  const browser = '08a-browser-verify',
    qa = '08d-adversarial-qa',
    learning = '11-phase-8-learning';
  const bOut = {
    ...outputs[roles[0]],
    resultStatus: 'failed',
    passed: false,
    failures: [{ description: 'browser broken' }],
    consoleErrors: ['TypeError'],
  };
  const qOut = {
    ...outputs[roles[1]],
    resultStatus: 'findings',
    findings: [{ severity: 'low', impact: 'edge case', location: 'a.ts' }],
    counts: { critical: 0, high: 0, total: 1 },
  };
  const old = [0, 1, 2].flatMap((round) => [
    { stepId: browser, round, output: bOut },
    { stepId: qa, round, output: qOut },
  ]);
  const canonical = renderTaskHistoryDigest(old, [], {});
  const entries = new Map(
    roles.map((role) => [
      `module.check.${role.split('.').at(-1)}`,
      { providesRoles: [{ role, contract: { id: role, version: 1 as const } }] },
    ]),
  );
  const ids = [...entries.keys(), learning];
  const task = {
    executionPath: 'full_workflow',
    runListSnapshot: ids,
    dataEdgePlan: buildDataEdgePlan('static', [
      { executionPath: null, nodes: dataPortNodes(ids, {}, entries) },
    ]),
  };
  const mapped = old.map((s) => ({
    ...s,
    status: 'done',
    stepId: s.stepId === browser ? ids[0]! : ids[1]!,
  }));
  expect(renderTaskHistoryDigest([...old, ...mapped], [], task)).toEqual(canonical);
  expect(
    renderTaskHistoryDigest(
      mapped.map((s) => ({ ...s, status: 'pending' })),
      [],
      task,
    ).findingCount,
  ).toBe(0);
});

it('QA browser URL/login uses its own pinned data input as prompt context', async () => {
  const { ctx, fake } = setup();
  const ids = ['module.check.browser-verification', '08d-adversarial-qa'];
  const entries = new Map([
    [
      ids[0]!,
      { providesRoles: [{ role: roles[0], contract: { id: roles[0], version: 1 as const } }] },
    ],
  ]);
  fake.patch(schema.tasks, ctx.taskId, {
    dataEdgePlan: buildDataEdgePlan('static', [
      { executionPath: null, nodes: dataPortNodes(ids, {}, entries) },
    ]),
    runListSnapshot: ids,
  });
  fake.patch(schema.taskSteps, ctx.taskStepId, { stepId: ids[1] });
  const number = vi.spyOn(configService, 'getNumber').mockResolvedValue(2);
  const boolean = vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
  try {
    const d = await adversarialQaStep.detect!(ctx);
    expect(d.appUrl).toBe('http://module');
    expect(d.appLogin).toEqual({ attempted: true, ok: true, reason: '' });
  } finally {
    number.mockRestore();
    boolean.mockRestore();
  }
});
it('tampered/unknown bindings are refused before any canonical fallback', async () => {
  const { ctx, fake } = setup();
  const task = fake.rows(schema.tasks)[0]!;
  const plan = structuredClone(task.dataEdgePlan) as any;
  plan.candidates[0].bindings['3:browser'] = {
    producerStepId: 'unknown',
    contract: { id: 'haive.browser-verification', version: 99 },
  };
  fake.patch(schema.tasks, ctx.taskId, { dataEdgePlan: plan });
  await expect(readRole(ctx, roles[0])).rejects.toThrow();
});

it('one producer can carry distinct QA and peer findings without losing either set', () => {
  const review = '08c-code-review',
    learning = '11-phase-8-learning';
  const nodes = dataPortNodes(
    [review, learning],
    {},
    new Map([
      [
        review,
        {
          providesRoles: [{ role: roles[1], contract: { id: roles[1], version: 1 as const } }],
        },
      ],
    ]),
  );
  const output = {
    ...outputs[roles[1]],
    resultStatus: 'findings',
    findings: [{ severity: 'low', impact: 'QA finding' }],
    counts: { critical: 0, high: 0, total: 1 },
    peer: { findings: [{ severity: 'high', issue: 'peer finding' }] },
  };
  expect(
    renderTaskHistoryDigest([{ stepId: review, round: 0, status: 'done', output }], [], {
      dataEdgePlan: buildDataEdgePlan('static', [{ executionPath: null, nodes }]),
      runListSnapshot: [review, learning],
    }).findingCount,
  ).toBe(2);
});
