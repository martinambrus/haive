import { StepRegistry } from '../src/step-engine/registry.js';
import { deadTaskResolution } from '../src/queues/dead-task-boot.js';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { SPEC_ROLES, STEP_ROLE_REGISTRY } from '@haive/shared/step-outputs';
import { buildDataEdgePlan } from '@haive/shared/data-edge-plan';
import { dataPortNodes } from '@haive/shared/step-ports';
import { readRole, legacyRoleOutput } from '../src/step-engine/read-role.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
const draft = STEP_ROLE_REGISTRY[SPEC_ROLES.draft].legacyStepId;
const consumer = '05-phase-0b5-spec-quality';
function fixture(selection: 'static' | 'derived' = 'static') {
  const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
  const taskId = randomUUID(),
    taskStepId = randomUUID();
  const nodes = dataPortNodes([draft, consumer]);
  nodes[0]!.id = 'pinned-producer';
  const plan = buildDataEdgePlan(
    selection,
    [
      { executionPath: null, nodes },
      { executionPath: 'quick_bugfix' as const, nodes },
    ].slice(0, selection === 'static' ? 1 : 2),
  );
  fake.insert(schema.tasks, { id: taskId, dataEdgePlan: plan });
  fake.insert(schema.taskSteps, {
    id: taskStepId,
    taskId,
    stepId: consumer,
    round: 1,
    status: 'running',
  });
  const put = (stepId: string, round: number, output: unknown, status = 'done') =>
    fake.insert(schema.taskSteps, {
      id: randomUUID(),
      taskId,
      stepId,
      round,
      output,
      status,
      iterations: [],
    });
  const ctx = { db: fake.db, taskId, taskStepId, round: 1 } as unknown as StepContext;
  put(draft, 1, { spec: 'canonical decoy' });
  put('pinned-producer', 0, { spec: 'pinned earlier' });
  put('pinned-producer', 2, { spec: 'future' });
  return { fake, ctx, put, plan, taskId };
}
it('v3 reads the exact pinned producer with an implicit current-round ceiling', async () => {
  const { ctx } = fixture();
  expect(await readRole(ctx, SPEC_ROLES.draft)).toMatchObject({
    state: 'ready',
    producer: { stepId: 'pinned-producer', round: 0 },
    data: { spec: 'pinned earlier' },
  });
});
it('newest row is selected before status; reset never exposes retained or older success', async () => {
  const { ctx, put } = fixture();
  put('pinned-producer', 1, { spec: 'stale retained' }, 'pending');
  const value = await readRole(ctx, SPEC_ROLES.draft);
  expect(value).toMatchObject({ state: 'not-ready', producer: { round: 1, status: 'pending' } });
  expect(legacyRoleOutput(value)).toEqual({});
});
it('unselected v3 candidates do not read a producer', async () => {
  const { ctx } = fixture('derived');
  expect(await readRole(ctx, SPEC_ROLES.draft)).toMatchObject({ state: 'unselected' });
});
it('missing binding or removed contract refuses without canonical fallback', async () => {
  const { ctx, fake, plan, taskId } = fixture();
  delete plan.candidates[0]!.bindings['1:draft'];
  fake.patch(schema.tasks, taskId, { dataEdgePlan: plan });
  await expect(readRole(ctx, SPEC_ROLES.draft)).rejects.toThrow('invalid-data-edge-plan');
});
it('tasks without v3 retain canonical identity and unbounded legacy round semantics', async () => {
  const { ctx, fake, taskId, put } = fixture();
  fake.patch(schema.tasks, taskId, { dataEdgePlan: null });
  put(draft, 3, { spec: 'legacy future retained' }, 'skipped');
  expect(legacyRoleOutput(await readRole(ctx, SPEC_ROLES.draft))).toEqual({
    spec: 'legacy future retained',
  });
});
it('unknown role diagnostics do not claim the role has host policy', async () => {
  const { ctx } = fixture();
  await expect(readRole(ctx, 'unknown-role' as never)).rejects.toThrow('unregistered role');
});

it('refuses unavailable pinned contracts at reads and boot, without remapping', async () => {
  const { ctx, fake, taskId } = fixture();
  const nodes = dataPortNodes([draft, consumer]);
  for (const n of nodes)
    for (const p of [...n.inputs, ...n.outputs]) p.contract = { ...p.contract, version: 2 };
  const pin = buildDataEdgePlan('static', [{ executionPath: null, nodes }]);
  fake.patch(schema.tasks, taskId, { dataEdgePlan: pin });
  await expect(readRole(ctx, 'draft')).rejects.toThrow('pinned contract unavailable');
  const registry = new StepRegistry();
  for (const id of [draft, consumer])
    registry.register({
      metadata: {
        id,
        title: id,
        description: '',
        workflowType: 'workflow',
        index: 1,
        requiresCli: false,
      },
      apply: async () => ({}),
    });
  expect(
    deadTaskResolution(
      {
        id: taskId,
        type: 'test',
        currentStepId: consumer,
        runListSnapshot: [draft, consumer],
        customSteps: null,
        dataEdgePlan: pin,
      },
      'static',
      registry,
    ),
  ).toMatchObject({ supportReason: expect.stringContaining('pinned-step-support-unavailable') });
  expect(fake.rows(schema.tasks)[0]!.dataEdgePlan).toEqual(pin);
});

it('an explicitly absent optional input never reads the canonical decoy', async () => {
  const { ctx, fake, taskId } = fixture();
  const pin = buildDataEdgePlan('static', [
    { executionPath: null, nodes: dataPortNodes([consumer]) },
  ]);
  fake.patch(schema.tasks, taskId, { dataEdgePlan: pin });
  expect(await readRole(ctx, 'draft')).toMatchObject({ state: 'absent', producer: null });
});
