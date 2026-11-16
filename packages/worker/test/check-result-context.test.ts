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
  it(`${selection}: house-rules row is byte identical for canonical and bound validation`, async () => {
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
    fake.insert(schema.taskSteps, {
      id: randomUUID(),
      taskId,
      stepId: validator,
      round: 0,
      status: 'done',
      output,
      iterations: [],
    });
    fake.insert(schema.cliInvocations, {
      id: invocation,
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
    fake.insert(schema.taskSteps, {
      id: randomUUID(),
      taskId,
      stepId: moduleValidator,
      round: 0,
      status: 'done',
      output,
      iterations: [],
    });
    fake.patch(schema.tasks, taskId, pin([moduleValidator, gate], selection));
    expect(
      JSON.stringify(
        houseRulesRow(
          await loadGateHouseRules(fake.db as unknown as Database, taskId, {
            consumer: { taskStepId, round: 1 },
          }),
        ),
      ),
    ).toBe(before);
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
