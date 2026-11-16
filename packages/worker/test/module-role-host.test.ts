import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFakeDb } from '@haive/database/testing';
import { schema } from '@haive/database';
import { logger } from '@haive/shared/logger';
import { TaskCancelledError, type StepContext } from '@haive/shared/step';
import { SPEC_ROLES, STEP_ROLE_REGISTRY } from '@haive/shared/step-outputs';
import { buildDataEdgePlan } from '@haive/shared/data-edge-plan';
import { dataPortNodes } from '@haive/shared/step-ports';
import { createStepHostServices } from '../src/step-engine/step-host-services.js';
import {
  assertMatchingOutputDeclaration,
  assertStepOutputDeclaration,
} from '../src/step-engine/step-output-contract.js';
import { assertDataEdgeSupport } from '../src/step-engine/data-edge-support.js';
const role = SPEC_ROLES.checked,
  contract = STEP_ROLE_REGISTRY[role].contract;
function fixture(optional = false) {
  const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
  const taskId = randomUUID(),
    taskStepId = randomUUID(),
    userId = randomUUID();
  const nodes = dataPortNodes(['05-phase-0b5-spec-quality', 'module.ports.use']);
  nodes[0]!.id = 'module.ports.check';
  nodes[1]!.inputs = [{ id: 'spec', role, contract, authorship: 'mixed', optional }];
  const plan = buildDataEdgePlan('static', [{ executionPath: null, nodes }]);
  fake.insert(schema.tasks, { id: taskId, userId, currentRound: 1, dataEdgePlan: plan });
  fake.insert(schema.taskSteps, {
    id: taskStepId,
    taskId,
    stepId: 'module.ports.use',
    round: 1,
    status: 'running',
  });
  fake.insert(schema.taskSteps, {
    id: randomUUID(),
    taskId,
    stepId: 'module.ports.check',
    round: 0,
    status: 'done',
    output: {
      spec: 'operator assignment',
      findings: [{ comment: 'agent attachment', secret: 'omit' }],
      secret: 'omit',
    },
    iterations: ['raw omit'],
  });
  const controller = new AbortController();
  const ctx = {
    db: fake.db,
    taskId,
    taskStepId,
    userId,
    round: 1,
    signal: controller.signal,
    logger,
    throwIfCancelled() {
      if (controller.signal.aborted) throw new TaskCancelledError();
    },
  } as unknown as StepContext;
  return { fake, ctx, controller, plan, host: createStepHostServices(ctx) };
}
it('returns a host spec view without raw output, storage extensions or iterations', async () => {
  const { host } = fixture();
  const result = await host.loadRoleOutput('spec');
  expect(result).toMatchObject({
    state: 'ready',
    producer: { stepId: 'module.ports.check', round: 0 },
    data: { adapter: 'spec', assignment: 'operator assignment' },
  });
  expect(JSON.stringify(result)).not.toContain('omit');
  expect(JSON.stringify(result)).toContain('agent attachment');
  expect(result).not.toHaveProperty('legacyOutput');
  expect(result).not.toHaveProperty('iterations');
});
it.each(['task', 'user', 'step', 'round'] as const)('refuses %s mismatch', async (kind) => {
  const { fake, ctx, host } = fixture();
  if (kind === 'task') fake.patch(schema.taskSteps, ctx.taskStepId, { taskId: randomUUID() });
  if (kind === 'user') fake.patch(schema.tasks, ctx.taskId, { userId: randomUUID() });
  if (kind === 'step') fake.patch(schema.taskSteps, ctx.taskStepId, { round: 2 });
  if (kind === 'round') fake.patch(schema.tasks, ctx.taskId, { currentRound: 0 });
  await expect(host.loadRoleOutput('spec')).rejects.toMatchObject({ name: 'StepHostBindingError' });
});
it('captures identity and honours cancellation', async () => {
  const { ctx, host, controller } = fixture();
  Object.assign(ctx, { taskId: 'foreign', userId: 'foreign', round: 99 });
  expect((await host.loadRoleOutput('spec')).state).toBe('ready');
  controller.abort();
  await expect(host.loadRoleOutput('spec')).rejects.toBeInstanceOf(TaskCancelledError);
});
it('fails required unavailable input by name; optional reset reports not-ready', async () => {
  for (const optional of [false, true]) {
    const { fake, ctx, host } = fixture(optional);
    fake.insert(schema.taskSteps, {
      id: randomUUID(),
      taskId: ctx.taskId,
      stepId: 'module.ports.check',
      round: 1,
      status: 'pending',
      output: { spec: 'stale' },
    });
    if (optional) expect(await host.loadRoleOutput('spec')).toMatchObject({ state: 'not-ready' });
    else
      await expect(host.loadRoleOutput('spec')).rejects.toThrow('spec: required input not ready');
  }
});
it('checks executable/manifest parity and data-role support without review policy', () => {
  const providesRoles = [{ role, contract }];
  const def = { providesRoles };
  expect(() =>
    assertStepOutputDeclaration({
      ...def,
      providesRoles: [{ role, contract: { ...contract, version: 2 } }],
    } as never),
  ).toThrow();
  expect(() =>
    assertMatchingOutputDeclaration(def as never, { stepId: 'check', providesRoles: [] } as never),
  ).toThrow('role');
  const { plan } = fixture();
  expect(() =>
    assertDataEdgeSupport({ dataEdgePlan: plan }, { get: () => def as never }),
  ).not.toThrow();
});

it('pre-dispatch validation enforces pinned required inputs even after executable declarations change', async () => {
  const { assertRequiredRoleInputs } = await import('../src/step-engine/module-role-read.js');
  const { ctx, fake, host } = fixture();
  ctx.host = host;
  fake.insert(schema.taskSteps, {
    id: randomUUID(),
    taskId: ctx.taskId,
    stepId: 'module.ports.check',
    round: 1,
    status: 'pending',
    output: null,
  });
  await expect(
    assertRequiredRoleInputs(ctx, {
      metadata: { id: 'module.ports.use' },
      consumesRoles: [],
    } as never),
  ).rejects.toThrow('spec: required input not ready');
});

it('cancels a role read while its awaited identity query is pending', async () => {
  const { ctx, controller, fake } = fixture();
  let release!: () => void;
  ctx.db = {
    ...ctx.db,
    query: {
      ...ctx.db.query,
      tasks: {
        findFirst: () =>
          new Promise((resolve) => {
            release = () => resolve(fake.rows(schema.tasks)[0]);
          }),
      },
    },
  } as unknown as StepContext['db'];
  const host = createStepHostServices(ctx);
  const pending = host.loadRoleOutput('spec');
  const rejected = expect(pending).rejects.toBeInstanceOf(TaskCancelledError);
  while (!release) await Promise.resolve();
  controller.abort();
  await rejected;
  release();
});

it('a standalone module data producer receives no review/audit replacement policy', async () => {
  const { registerModuleSteps } = await import('../src/modules/loader.js');
  const { StepRegistry } = await import('../src/step-engine/registry.js');
  const registry = new StepRegistry();
  const providesRoles = [{ role, contract }];
  const step = {
    metadata: {
      id: 'check',
      workflowType: 'ports',
      title: 'Check',
      index: 0,
      description: '',
      requiresCli: false,
    },
    providesRoles,
    apply: async () => ({ spec: 'checked' }),
  };
  registerModuleSteps(registry, [
    {
      packageName: '@haive/module-ports',
      manifest: {
        id: 'ports',
        name: 'Ports',
        version: '1',
        schemaVersion: 1,
        composableSteps: [
          {
            stepId: 'check',
            label: 'Check',
            group: 'build',
            dispatchesCli: false,
            requires: [],
            provides: [],
            providesRoles,
          },
        ],
      },
      steps: [step],
    },
  ]);
  const registered = registry.get('module.ports.check');
  expect(registered?.providesRoles).toEqual(providesRoles);
  for (const policy of [
    'replaces',
    'fixLoop',
    'fixLoopOnError',
    'loop',
    'restartLoop',
    'reviseLoop',
  ])
    expect(registered).not.toHaveProperty(policy);
});

it('a malformed successful module data output fails the producer without a review policy', async () => {
  const { validateSuccessfulStepOutput, StepOutputContractInvalidError } =
    await import('../src/step-engine/step-output-contract.js');
  const step = {
    metadata: { id: 'module.ports.check' },
    providesRoles: [{ role, contract }],
  } as never;
  expect(() =>
    validateSuccessfulStepOutput(
      step,
      { spec: 123 },
      {
        warn() {
          throw new Error('data producer must fail');
        },
      },
    ),
  ).toThrow(StepOutputContractInvalidError);
});

it.each(['absent', 'unselected', 'invalid'] as const)(
  'exposes the optional %s state without raw producer data',
  async (state) => {
    const { ctx, host, fake, plan } = fixture(true);
    if (state === 'absent')
      fake.patch(schema.tasks, ctx.taskId, {
        dataEdgePlan: buildDataEdgePlan('static', [
          { executionPath: null, nodes: [plan.candidates[0]!.nodes[1]!] },
        ]),
      });
    if (state === 'unselected')
      fake.patch(schema.tasks, ctx.taskId, {
        dataEdgePlan: buildDataEdgePlan('derived', [
          { executionPath: null, nodes: plan.candidates[0]!.nodes },
        ]),
      });
    if (state === 'invalid')
      fake.insert(schema.taskSteps, {
        id: randomUUID(),
        taskId: ctx.taskId,
        stepId: 'module.ports.check',
        round: 1,
        status: 'done',
        output: { spec: 123, secret: 'never expose' },
      });
    const result = await host.loadRoleOutput('spec');
    expect(result.state).toBe(state);
    expect(result).not.toHaveProperty('data');
    expect(result).not.toHaveProperty('legacyOutput');
  },
);

it('requires host-policy executable support even with a matching data-role declaration', () => {
  const review = '08c-code-review';
  const ref = STEP_ROLE_REGISTRY[review].contract;
  const nodes = dataPortNodes([review, '09-gate-2-verify-approval']);
  nodes[0]!.id = 'module.ports.review';
  const plan = buildDataEdgePlan('static', [{ executionPath: null, nodes }]);
  const get = () => ({ providesRoles: [{ role: review, contract: ref }] }) as never;
  expect(() => assertDataEdgeSupport({ dataEdgePlan: plan }, { get })).toThrow(
    'pinned-step-support-unavailable',
  );
  expect(() =>
    assertDataEdgeSupport(
      { dataEdgePlan: plan },
      {
        get: () => ({ outputContract: ref }) as never,
      },
    ),
  ).not.toThrow();
});
