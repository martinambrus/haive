import { rolePin, PRODUCER } from './step-role-fixtures.js';
import type { RolePortDeclarations } from '@haive/shared/modularity';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { buildDataEdgePlan } from '@haive/shared/data-edge-plan';
import { dataPortNodes } from '@haive/shared/step-ports';
import {
  loadGateHouseRules,
  houseRulesRow,
  houseRulesHoldApprove,
} from '../src/step-engine/steps/workflow/_gate-house-rules.js';
import { renderTaskHistoryDigest } from '../src/step-engine/steps/workflow/_task-history-digest.js';
const validation = 'haive.validation',
  verify = 'haive.verify';
const validator = '07b-phase-4-validate',
  runner = '08-phase-5-verify';
const gate = '09-gate-2-verify-approval',
  learning = '11-phase-8-learning';
const moduleValidator = 'module.check.validator',
  moduleRunner = 'module.check.runner';
const rule = '42ac658a-3c1d-4e5f-8a9b-0c1d2e3f4a5b';
const invocation = randomUUID();
const issue = {
  severity: 'high',
  file: 'a.ts',
  description: 'rule violation',
  fix: 'repair',
  rule: rule.slice(0, 8),
};
const output = {
  resultStatus: 'failed',
  exhaustedBudget: false,
  verdict: 'ISSUES_FOUND',
  summary: 'found',
  issues: [issue],
  dimensions: [],
  excludedDimensions: [],
  fixesApplied: [],
  converged: true,
  churnFiles: [],
  report: '',
  validatorPasses: 1,
  validatorInvocationId: invocation,
  ruleConflicts: [{ rule: rule.slice(0, 8), reason: 'spec requires exception' }],
  changedFilesCoverage: { listed: 2, total: 3 },
};
const check = { ran: true, passed: true, command: 'test', output: 'passed' };
const verifyOutput = {
  resultStatus: 'passed',
  test: check,
  lint: check,
  typecheck: check,
  passed: true,
  runtimeSmoke: {
    ran: true,
    passed: false,
    httpStatus: 500,
    url: 'http://localhost',
    errorExcerpt: 'error',
  },
  declaredSlots: [],
  declinedConfigs: [],
  offSlots: [],
  slotWithoutRunner: false,
};
function pin(ids: string[], selection: 'static' | 'derived') {
  const entries = new Map<string, RolePortDeclarations>([
    [
      moduleValidator,
      { providesRoles: [{ role: validation, contract: { id: validation, version: 1 as const } }] },
    ],
    [
      moduleRunner,
      { providesRoles: [{ role: verify, contract: { id: verify, version: 1 as const } }] },
    ],
  ]);
  const nodes = dataPortNodes(ids, {}, entries);
  return {
    dataEdgePlan: buildDataEdgePlan(selection, [
      { executionPath: null, nodes },
      ...(selection === 'derived' ? [{ executionPath: 'full_workflow' as const, nodes }] : []),
    ]),
    executionPath: 'full_workflow',
    runListSnapshot: ids,
  };
}
for (const selection of ['static', 'derived'] as const) {
  it(`${selection}: house-rules findings survive an owned bound invocation with explicit fingerprint caveat`, async () => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      cliInvocations: schema.cliInvocations,
    });
    const taskId = randomUUID(),
      taskStepId = randomUUID();
    fake.insert(schema.tasks, { id: taskId });
    fake.insert(schema.taskSteps, {
      id: taskStepId,
      taskId,
      stepId: gate,
      round: 1,
      status: 'running',
    });
    const canonicalRowId = randomUUID();
    fake.insert(schema.taskSteps, {
      id: canonicalRowId,
      taskId,
      stepId: validator,
      round: 0,
      status: 'done',
      output,
      iterations: [],
    });
    fake.insert(schema.cliInvocations, {
      id: invocation,
      taskId,
      taskStepId: canonicalRowId,
      houseRules: {
        mode: 'review',
        entries: [
          {
            id: rule,
            hash: `hr1:${'a'.repeat(64)}`,
            title: 'House rule',
            why: { scope: 'always' },
          },
        ],
        omitted: [],
      },
    });
    const before = JSON.stringify(
      houseRulesRow(await loadGateHouseRules(fake.db as unknown as Database, taskId)),
    );
    const moduleRowId = randomUUID();
    fake.insert(schema.taskSteps, {
      id: moduleRowId,
      taskId,
      stepId: moduleValidator,
      round: 0,
      status: 'done',
      output,
      iterations: [],
    });
    // Each producer must name its own invocation, with the same host stamp.
    fake.patch(schema.cliInvocations, invocation, { taskStepId: moduleRowId });
    fake.patch(schema.tasks, taskId, pin([moduleValidator, gate], selection));
    const bound = houseRulesRow(
      await loadGateHouseRules(fake.db as unknown as Database, taskId, {
        consumer: { taskStepId, round: 1 },
      }),
    );
    const canonical = JSON.parse(before);
    expect(bound).toEqual({
      ...canonical,
      detail: canonical.detail.replace(
        '1 conflict(s)',
        "the check's change fingerprint could not be verified; 1 conflict(s)",
      ),
      body: canonical.body.replace(
        '\n\n## Conflicts',
        "\n- the check's change fingerprint could not be verified\n\n## Conflicts",
      ),
    });
    expect(before).toContain('CONFLICT');
  });
  it(`${selection}: historical role reads preserve every round and exact digest bytes`, () => {
    const canonical = [0, 1].flatMap((round) => [
      { stepId: validator, round, output },
      { stepId: runner, round, output: verifyOutput },
    ]);
    const expected = JSON.stringify(renderTaskHistoryDigest(canonical, [], {}));
    const replacement = canonical.map((s) => ({
      ...s,
      stepId: s.stepId === validator ? moduleValidator : moduleRunner,
    }));
    expect(
      JSON.stringify(
        renderTaskHistoryDigest(
          replacement,
          [],
          pin([moduleValidator, moduleRunner, learning], selection),
        ),
      ),
    ).toBe(expected);
    expect(JSON.parse(expected).findingCount).toBe(2);
    expect(expected).toContain('runtime smoke');
  });
}
it('an unselected historical candidate supplies no findings or passing evidence', () => {
  const task = pin([moduleValidator, moduleRunner, learning], 'derived');
  expect(
    renderTaskHistoryDigest([{ stepId: moduleValidator, round: 0, output }], [], {
      ...task,
      executionPath: null,
    }).findingCount,
  ).toBe(0);
});

it('one producer may supply validation and review without hiding either historical finding', () => {
  const review = '08c-code-review';
  const nodes = dataPortNodes(
    [review, learning],
    {},
    new Map([
      [review, { providesRoles: [{ role: validation, contract: { id: validation, version: 1 } }] }],
    ]),
  );
  const task = {
    dataEdgePlan: buildDataEdgePlan('static', [{ executionPath: null, nodes }]),
    runListSnapshot: [review, learning],
  };
  const combined = {
    ...output,
    peer: { findings: [{ severity: 'high', path: 'b.ts', issue: 'peer finding' }] },
  };
  expect(
    renderTaskHistoryDigest([{ stepId: review, round: 0, output: combined }], [], task)
      .findingCount,
  ).toBe(2);
});

// A module's invocation id and fingerprint are claims, not host evidence.
for (const kind of ['validation', 'review'] as const) {
  for (const ownership of ['own', 'other-row', 'other-task', 'missing', 'malformed'] as const) {
    it(`${kind}: a module stamp requires the same task and producer row (${ownership})`, async () => {
      const fake = createFakeDb({
        tasks: schema.tasks,
        taskSteps: schema.taskSteps,
        cliInvocations: schema.cliInvocations,
      });
      const taskId = randomUUID(),
        taskStepId = randomUUID(),
        producerId = randomUUID(),
        invocationId = randomUUID();
      const canonicalRowId = randomUUID();
      fake.insert(schema.taskSteps, {
        id: canonicalRowId,
        taskId,
        stepId: kind === 'review' ? '08c-code-review' : validator,
        round: 0,
        status: 'done',
        output: { validatorInvocationId: invocationId, peerInvocationId: invocationId },
      });
      const review = kind === 'review';
      const producer = review ? PRODUCER : moduleValidator;
      fake.insert(schema.tasks, {
        id: taskId,
        ...(review ? rolePin() : pin([producer, gate], 'static')),
      });
      fake.insert(schema.taskSteps, {
        id: taskStepId,
        taskId,
        stepId: gate,
        round: 1,
        status: 'running',
      });
      const invocationKey = review ? 'peerInvocationId' : 'validatorInvocationId';
      const evidence = review
        ? {
            reviewed: true,
            peer: { verdict: 'APPROVE', findings: [], positives: [] },
            security: { verdict: 'SAFE', findings: [] },
            extraLenses: [],
            blocking: false,
            reviewIncomplete: false,
            advisoryVerdict: false,
            coverage: null,
            refutedCount: 0,
            counts: { peer: 0, securityCriticalHigh: 0 },
            recurringNote: '',
          }
        : {
            ...output,
            resultStatus: 'passed',
            verdict: 'VALID',
            issues: [],
            ruleConflicts: [],
            changedFilesCoverage: { listed: 1, total: 1 },
          };
      fake.insert(schema.taskSteps, {
        id: producerId,
        taskId,
        stepId: producer,
        round: 0,
        status: 'done',
        output: {
          ...evidence,
          [invocationKey]:
            ownership === 'missing'
              ? null
              : ownership === 'malformed'
                ? 'not-a-uuid'
                : invocationId,
          changeFingerprint: 'module-claim',
        },
        iterations: [],
      });
      fake.insert(schema.cliInvocations, {
        id: invocationId,
        taskId: ownership === 'other-task' ? randomUUID() : taskId,
        taskStepId: ownership === 'other-row' ? canonicalRowId : producerId,
        houseRules: {
          mode: 'review',
          entries: [
            {
              id: rule,
              hash: `hr1:${'a'.repeat(64)}`,
              title: 'House rule',
              why: { scope: 'always' },
            },
          ],
          omitted: [],
        },
      });
      const rules = await loadGateHouseRules(fake.db as unknown as Database, taskId, {
        withCodeReview: review,
        consumer: { taskStepId, round: 1 },
        currentFingerprint: async () => 'module-claim',
      });
      const row = houseRulesRow(rules);
      expect(row?.statusLabel).toBe(ownership === 'own' ? 'PARTIAL' : 'NOT CHECKED');
      expect(houseRulesHoldApprove(rules)).toBe(true);
      expect(rules?.entries).toHaveLength(ownership === 'own' ? 1 : 0);
    });
  }
}

it('mines one row once when it is both the review binding and a physical finding step', () => {
  const qa = '08d-adversarial-qa';
  const task = JSON.parse(JSON.stringify(rolePin()).replaceAll(PRODUCER, qa));
  const combined = {
    peer: { findings: [{ severity: 'high', path: 'a.ts', issue: 'one finding' }] },
    findings: [{ severity: 'high', location: 'a.ts', impact: 'one finding' }],
  };
  const expected = renderTaskHistoryDigest(
    [{ stepId: '08c-code-review', round: 0, output: combined }],
    [],
    {},
  );
  const actual = renderTaskHistoryDigest([{ stepId: qa, round: 0, output: combined }], [], task);
  expect(actual).toEqual(expected);
  expect(actual.findingCount).toBe(1);
});

it('a later canonical peer cannot hide an unverified module validation invocation', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    cliInvocations: schema.cliInvocations,
  });
  const taskId = randomUUID(),
    taskStepId = randomUUID(),
    reviewRowId = randomUUID(),
    peerInvocationId = randomUUID();
  const review = '08c-code-review';
  fake.insert(schema.tasks, { id: taskId, ...pin([moduleValidator, review, gate], 'static') });
  fake.insert(schema.taskSteps, {
    id: taskStepId,
    taskId,
    stepId: gate,
    round: 1,
    status: 'running',
  });
  fake.insert(schema.taskSteps, {
    id: randomUUID(),
    taskId,
    stepId: moduleValidator,
    round: 0,
    status: 'done',
    iterations: [],
    output: {
      ...output,
      resultStatus: 'passed',
      verdict: 'VALID',
      issues: [],
      ruleConflicts: [],
      changedFilesCoverage: { listed: 1, total: 1 },
      validatorInvocationId: null,
    },
  });
  fake.insert(schema.taskSteps, {
    id: reviewRowId,
    taskId,
    stepId: review,
    round: 0,
    status: 'done',
    output: { peerInvocationId, peer: { findings: [] } },
  });
  fake.insert(schema.cliInvocations, {
    id: peerInvocationId,
    taskId,
    taskStepId: reviewRowId,
    houseRules: {
      mode: 'review',
      entries: [
        { id: rule, hash: `hr1:${'a'.repeat(64)}`, title: 'House rule', why: { scope: 'always' } },
      ],
      omitted: [],
    },
  });
  const rules = await loadGateHouseRules(fake.db as unknown as Database, taskId, {
    withCodeReview: true,
    consumer: { taskStepId, round: 1 },
  });
  expect(houseRulesRow(rules)?.statusLabel).toBe('NOT CHECKED');
  expect(houseRulesHoldApprove(rules)).toBe(true);
});
