import { z } from 'zod';
import { moduleManifestSchema } from '@haive/shared/modularity';
import { registerModuleExecutionPredicates } from '../src/modules/execution-predicates.js';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { Hono } from 'hono';
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async () => undefined),
  kill: vi.fn(async () => ({ killed: 0, killConfirmed: true })),
}));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: h.kill }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(k: string, v: string): void }, next: () => Promise<void>) => {
    c.set('userId', '00000000-0000-4000-8000-000000000001');
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true, getFresh: async () => 'normal' },
}));
import { definitionForCreate } from '../src/lib/task-type-definition.js';
import { markQueuedForStart } from '../src/lib/task-start.js';
import { seedStepCatalog } from './step-flags-fixture.js';
import { retryTaskAtStep } from '../src/routes/tasks/steps.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const USER = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-000000000002';
const empty = { version: 1, guardedSpans: [] };
const guarded = {
  version: 1,
  guardedSpans: [
    {
      id: 'a',
      firstStepId: 'report',
      lastStepId: 'report',
      predicateId: 'module.fx.planned',
      args: {},
    },
  ],
};
// A capable core step still fails the module-target shape requirement.
const fixed = { ...empty, fixTarget: { stepId: 'report', capabilityVersion: 1 } };
function setup(contract: unknown = null) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskTypeDefinitions: schema.taskTypeDefinitions,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    taskDatabaseStates: schema.taskDatabaseStates,
    mergeDirClaims: schema.mergeDirClaims,
    stepCatalog: schema.stepCatalog,
    modules: schema.modules,
    repositories: schema.repositories,
    taskAttachments: schema.taskAttachments,
    auditEvents: schema.auditEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
    taskStepCliChoices: schema.taskStepCliChoices,
  });
  h.db = fake.db;
  fake.insert(schema.repositories, {
    id: USER,
    userId: USER,
    status: 'ready',
    name: 'repo',
    storagePath: '/unused/p6',
  });
  fake.insert(schema.taskTypeDefinitions, {
    slug: 'test',
    displayName: 'Test',
    source: 'admin',
    runListStrategy: 'static',
    stepIds: ['lead', 'report', 'tail'],
    enabled: true,
    selectable: true,
    requiresRepository: false,
    preAnswerDefaults: {},
    stepLoopLimitDefaults: {},
    promptSteps: {},
    executionContract: contract,
  });
  fake.insert(schema.stepCatalog, {
    stepId: 'lead',
    source: 'core',
    workflowType: 'test',
    stepIndex: 1,
    composable: true,
    dispatchesCli: false,
    entry: {
      stepId: 'lead',
      label: 'Lead',
      group: 'test',
      requires: [],
      provides: [],
      dispatchesCli: false,
    },
  });
  fake.insert(schema.stepCatalog, {
    stepId: 'report',
    source: 'core',
    workflowType: 'test',
    stepIndex: 2,
    composable: true,
    dispatchesCli: false,
    entry: {
      stepId: 'report',
      label: 'Report',
      group: 'test',
      requires: [],
      provides: [],
      dispatchesCli: false,
      fixConsumer: { version: 1 },
    },
  });
  fake.insert(schema.stepCatalog, {
    stepId: 'tail',
    source: 'core',
    workflowType: 'test',
    stepIndex: 3,
    composable: true,
    dispatchesCli: false,
    entry: {
      stepId: 'tail',
      label: 'Tail',
      group: 'test',
      requires: [],
      provides: [],
      dispatchesCli: false,
    },
  });
  return fake;
}
beforeEach(() => {
  // Keep these runtime-refusal fixtures structurally valid under schema-aware
  // admission: report is capable, and the unguarded tail keeps every path nonempty.
  registerModuleExecutionPredicates(
    [{ executionPredicates: [{ id: 'planned', argsSchema: z.strictObject({}) }] }],
    [
      {
        manifest: moduleManifestSchema.parse({
          id: 'fx',
          name: 'Fx',
          version: '1',
          schemaVersion: 1,
        }),
      },
    ],
  );
  h.add.mockClear();
  h.kill.mockClear();
});
it('an invalid derived definition carrying a live pin still returns the named execution refusal', async () => {
  const fake = setup(guarded);
  await fake.db
    .update(schema.taskTypeDefinitions)
    .set({ runListStrategy: 'derived', stepIds: null, baseSlug: 'missing', changes: [] })
    .where(eq(schema.taskTypeDefinitions.slug, 'test'));
  await expect(
    definitionForCreate(fake.db as never, 'test', { generic: true, locked: false }),
  ).rejects.toMatchObject({ status: 409, code: 'invalid-execution-contract' });
  expect(fake.rows(schema.tasks)).toEqual([]);
  expect(fake.rows(schema.taskEvents)).toEqual([]);
  expect(h.add).not.toHaveBeenCalled();
});
it.each([
  'test',
  'onboarding_upgrade',
  'kb_author',
  'plan_build',
  'plan_chat',
  'advisory',
  'plan_sequence',
  'plan_merge',
  'type_draft',
])(
  'the common locked admission for %s refuses a non-module fix target or malformed pin before pinning',
  async (slug) => {
    for (const contract of [fixed, { version: 99 }]) {
      const fake = setup(contract);
      await fake.db
        .update(schema.taskTypeDefinitions)
        .set({ slug, source: slug === 'test' ? 'admin' : 'builtin' })
        .where(eq(schema.taskTypeDefinitions.slug, 'test'));
      await expect(
        fake.db.transaction((tx) =>
          definitionForCreate(tx as never, slug, { generic: slug === 'test', locked: true }),
        ),
      ).rejects.toMatchObject({ status: 409, code: 'invalid-execution-contract' });
      expect(fake.rows(schema.tasks)).toEqual([]);
      expect(fake.rows(schema.taskEvents)).toEqual([]);
      expect(h.add).not.toHaveBeenCalled();
      expect(h.kill).not.toHaveBeenCalled();
    }
  },
);
it.each([
  'test',
  'onboarding_upgrade',
  'kb_author',
  'plan_build',
  'plan_chat',
  'advisory',
  'plan_sequence',
  'plan_merge',
  'type_draft',
])('the common locked admission for %s admits an empty and a guarded pin', async (slug) => {
  for (const contract of [empty, guarded]) {
    const fake = setup(contract);
    await fake.db
      .update(schema.taskTypeDefinitions)
      .set({ slug, source: slug === 'test' ? 'admin' : 'builtin' })
      .where(eq(schema.taskTypeDefinitions.slug, 'test'));
    const definition = await fake.db.transaction((tx) =>
      definitionForCreate(tx as never, slug, { generic: slug === 'test', locked: true }),
    );
    expect(definition.executionContract).toEqual(contract);
    expect(definition.runListSnapshot).toEqual(['lead', 'report', 'tail']);
  }
});
it.each([fixed, { version: 99 }])(
  'create refuses unsupported contracts before task, event or queue writes',
  async (contract) => {
    const fake = setup(contract);
    const app = new Hono<AppEnv>();
    app.route('/tasks', taskRoutes);
    app.onError(errorHandler);
    const res = await app.request('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'test', title: 'Test', description: 'test' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'invalid-execution-contract' });
    expect(fake.rows(schema.tasks)).toEqual([]);
    expect(fake.rows(schema.taskEvents)).toEqual([]);
    expect(h.add).not.toHaveBeenCalled();
  },
);
it.each([empty, guarded])(
  'create pins a supported contract byte-equal on the inserted task',
  async (contract) => {
    const fake = setup(contract);
    const app = new Hono<AppEnv>();
    app.route('/tasks', taskRoutes);
    app.onError(errorHandler);
    const res = await app.request('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'test',
        title: 'Pinned',
        description: 'pinned',
        repositoryId: USER,
        deferStart: true,
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const tasks = fake.rows(schema.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.executionContract).toEqual(contract);
    expect(tasks[0]!.runListSnapshot).toEqual(['lead', 'report', 'tail']);
  },
);
it.each([fixed, { version: 99 }])(
  'START refuses a pinned unsupported contract without changing a row, event or job',
  async (contract) => {
    const fake = setup();
    const task = fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      type: 'test',
      status: 'created',
      executionContract: contract,
    });
    await expect(markQueuedForStart(fake.db as never, TASK)).rejects.toMatchObject({
      status: 409,
      code: 'invalid-execution-contract',
    });
    expect(fake.rows(schema.tasks)).toEqual([task]);
    expect(fake.rows(schema.taskEvents)).toEqual([]);
    expect(h.add).not.toHaveBeenCalled();
  },
);
it.each([empty, guarded])(
  'START queues a task pinned with a supported contract',
  async (contract) => {
    const fake = setup();
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      type: 'test',
      status: 'created',
      executionContract: contract,
    });
    const queued = await markQueuedForStart(fake.db as never, TASK);
    expect(queued).toMatchObject({ id: TASK, status: 'queued', executionContract: contract });
    expect(fake.rows(schema.tasks)[0]).toMatchObject({
      status: 'queued',
      executionContract: contract,
    });
  },
);
it('pins an inert valid contract with data edges on the locked INSERT and keeps it across definition edits', async () => {
  const fake = setup(empty);
  const app = new Hono<AppEnv>();
  app.route('/tasks', taskRoutes);
  app.onError(errorHandler);
  const result = await app.request('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'test',
      title: 'Pinned',
      description: 'pinned',
      repositoryId: USER,
      deferStart: true,
    }),
  });
  expect(result.status, JSON.stringify(await result.json())).toBe(201);
  const task = fake.rows(schema.tasks)[0]!;
  expect(task.executionContract).toEqual(empty);
  expect(task.dataEdgePlan).toMatchObject({ version: 3 });
  await fake.db
    .update(schema.taskTypeDefinitions)
    .set({ executionContract: guarded })
    .where(eq(schema.taskTypeDefinitions.slug, 'test'));
  expect(fake.rows(schema.tasks)[0]!.executionContract).toEqual(empty);
  expect(result).toBeDefined();
});
it.each(['workflow_paths', 'run_app_modes'] as const)(
  'a %s type with a guarded pin refuses with the named code and writes nothing',
  async (strategy) => {
    const fake = setup(guarded);
    await fake.db
      .update(schema.taskTypeDefinitions)
      .set({ runListStrategy: strategy, stepIds: null })
      .where(eq(schema.taskTypeDefinitions.slug, 'test'));
    await expect(
      definitionForCreate(fake.db as never, 'test', { generic: true, locked: false }),
    ).rejects.toMatchObject({ status: 409, code: 'invalid-execution-contract' });
    expect(fake.rows(schema.tasks)).toEqual([]);
    expect(fake.rows(schema.taskEvents)).toEqual([]);
    expect(h.add).not.toHaveBeenCalled();
  },
);
it('plain static and unseeded builtins keep NULL contract semantics', async () => {
  const fake = setup();
  expect(
    (
      await fake.db.transaction((tx) =>
        definitionForCreate(tx as never, 'test', { generic: true, locked: true }),
      )
    ).executionContract,
  ).toBeNull();
  expect(
    (await definitionForCreate(fake.db as never, 'workflow', { generic: true, locked: true }))
      .executionContract ?? null,
  ).toBeNull();
});

const STEP = '11d-skill-sync';
const STEP_ROW = '00000000-0000-4000-8000-000000000003';
function stopped(contract: unknown, stepStatus: string = 'failed') {
  const fake = setup();
  seedStepCatalog(fake);
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: USER,
    type: 'test',
    status: 'failed',
    orchestrationEpoch: 3,
    currentStepId: STEP,
    currentRound: 0,
    runListSnapshot: [STEP, 'report'],
    executionContract: contract,
    pausedAt: new Date('2026-01-01'),
  });
  fake.insert(schema.taskSteps, {
    id: STEP_ROW,
    taskId: TASK,
    stepId: STEP,
    status: stepStatus,
    stepIndex: 1,
    runSeq: 1,
    round: 0,
    iterationCount: 1,
    iterations: [{ output: { summary: 'retained pass' } }],
    formSchema: { title: 'Answer', fields: [] },
    formValues: { kept: true },
    waitingStartedAt: new Date('2026-01-01'),
  });
  fake.insert(schema.taskSteps, {
    id: '00000000-0000-4000-8000-000000000004',
    taskId: TASK,
    stepId: 'report',
    status: 'waiting_cli',
    stepIndex: 2,
    runSeq: 2,
    round: 0,
  });
  fake.insert(schema.cliInvocations, {
    id: '00000000-0000-4000-8000-000000000005',
    taskId: TASK,
    taskStepId: STEP_ROW,
    mode: 'cli',
    prompt: 'test',
  });
  fake.insert(schema.taskStepAgentMinings, {
    taskStepId: STEP_ROW,
    agentId: 'peer-reviewer',
    status: 'failed',
    rawOutput: 'retained reply',
  });
  return fake;
}
function state(fake: ReturnType<typeof setup>) {
  return structuredClone([
    fake.rows(schema.tasks),
    fake.rows(schema.taskSteps),
    fake.rows(schema.cliInvocations),
    fake.rows(schema.taskStepAgentMinings),
    fake.rows(schema.taskEvents),
    fake.rows(schema.taskStepCliChoices),
  ]);
}
const requestCases: {
  label: string;
  path: string;
  body: Record<string, unknown>;
  method?: string;
  status?: string;
  taskStatus?: 'waiting_user';
}[] = [
  { label: 'task Retry at a step', path: '/action', body: { action: 'retry' } },
  ...['retry', 'resume', 'retry_ai', 'skip'].map((action) => ({
    label: `step ${action}`,
    path: `/steps/${STEP}/action`,
    body: { action, round: 0 },
  })),
  {
    label: 'form answer',
    path: `/steps/${STEP}/submit`,
    body: { values: { answer: 'go' } },
    status: 'waiting_form',
  },
  {
    label: 'clarification',
    path: `/steps/${STEP}/clarify`,
    body: { answer: 'go' },
    status: 'waiting_form',
  },
  {
    label: 'provider switch',
    path: `/steps/${STEP}/cli-provider`,
    method: 'PATCH',
    body: { cliProviderId: null, round: 0 },
  },
  {
    label: 'auto-continue wakeup',
    path: '',
    method: 'PATCH',
    body: { autoContinue: true },
    taskStatus: 'waiting_user',
  },
  { label: 'pause Resume', path: '/action', body: { action: 'resume' } },
];
for (const contract of [fixed, { version: 99 }]) {
  it.each(requestCases)(
    'refuses $label for an unsupported pin without side effects',
    async (test) => {
      const fake = stopped(contract, test.status);
      if (test.taskStatus)
        await fake.db
          .update(schema.tasks)
          .set({ status: test.taskStatus })
          .where(eq(schema.tasks.id, TASK));
      const before = state(fake);
      const app = new Hono<AppEnv>();
      app.route('/tasks', taskRoutes);
      app.onError(errorHandler);
      const res = await app.request(`/tasks/${TASK}${test.path}`, {
        method: test.method ?? 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(test.body),
      });
      expect(res.status, await res.clone().text()).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'invalid-execution-contract' });
      expect(state(fake)).toEqual(before);
      expect(h.kill).not.toHaveBeenCalled();
      expect(h.add).not.toHaveBeenCalled();
    },
  );
}
/** `reopens`: the press re-runs the step, so its event is one the step runner's auth admission
 *  window starts from (`AUTH_LEDGER_PRESS_EVENTS`, or `AUTH_LEDGER_SWITCH_EVENT` for the switch) and
 *  must name the step row it re-runs: with no step id the gate ignores it. */
const effects: Record<string, { event: string; job: boolean; kill: boolean; reopens?: true }> = {
  'task Retry at a step': { event: 'task.retried', job: true, kill: true, reopens: true },
  'step retry': { event: 'step.retry', job: true, kill: true, reopens: true },
  'step resume': { event: 'step.resume', job: true, kill: true, reopens: true },
  'step retry_ai': { event: 'step.retry_ai', job: true, kill: true, reopens: true },
  'step skip': { event: 'step.skip', job: true, kill: true },
  'form answer': { event: 'step.form_submitted', job: true, kill: false },
  clarification: { event: 'step.clarified', job: true, kill: false },
  'provider switch': {
    event: 'step.cli_provider_preference_changed',
    job: false,
    kill: false,
    reopens: true,
  },
  'auto-continue wakeup': { event: 'task.auto_continue_changed', job: true, kill: false },
  'pause Resume': { event: 'task.resumed', job: false, kill: false },
};
for (const contract of [empty, guarded]) {
  it.each(requestCases)('admits $label for a supported pin with its effects', async (test) => {
    const fake = stopped(contract, test.status);
    if (test.taskStatus)
      await fake.db
        .update(schema.tasks)
        .set({ status: test.taskStatus })
        .where(eq(schema.tasks.id, TASK));
    const app = new Hono<AppEnv>();
    app.route('/tasks', taskRoutes);
    app.onError(errorHandler);
    const res = await app.request(`/tasks/${TASK}${test.path}`, {
      method: test.method ?? 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(test.body),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const effect = effects[test.label]!;
    expect(fake.rows(schema.taskEvents).map((e) => e.eventType)).toContain(effect.event);
    if (effect.reopens)
      expect(fake.rows(schema.taskEvents).find((e) => e.eventType === effect.event)).toMatchObject({
        taskStepId: fake.rows(schema.taskSteps)[0]!.id,
      });
    if (effect.job)
      expect(h.add).toHaveBeenCalledWith('advance-step', expect.anything(), expect.anything());
    else expect(h.add).not.toHaveBeenCalled();
    if (effect.kill) expect(h.kill).toHaveBeenCalled();
    else expect(h.kill).not.toHaveBeenCalled();
    expect(fake.rows(schema.tasks)[0]!.executionContract).toEqual(contract);
  });
}
it('direct task-at-step Retry refuses before resetting or killing in-flight work', async () => {
  const fake = stopped(fixed);
  const before = state(fake);
  const target = fake.rows(schema.taskSteps)[0]!;
  await expect(
    retryTaskAtStep(fake.db as never, TASK, USER, target as never),
  ).rejects.toMatchObject({
    status: 409,
    code: 'invalid-execution-contract',
  });
  expect(state(fake)).toEqual(before);
  expect(h.kill).not.toHaveBeenCalled();
  expect(h.add).not.toHaveBeenCalled();
});

it.each([null, empty, guarded])(
  'retains task-at-step Retry for a supported pin',
  async (contract) => {
    const fake = stopped(contract);
    await expect(
      retryTaskAtStep(fake.db as never, TASK, USER, fake.rows(schema.taskSteps)[0]! as never),
    ).resolves.toEqual({ epoch: 4, killed: 0, killConfirmed: true });
    expect(fake.rows(schema.tasks)[0]).toMatchObject({
      status: 'running',
      executionContract: contract,
    });
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(h.add).toHaveBeenCalledTimes(1);
  },
);

it.each([
  {
    label: 'a non-module fix target',
    pin: fixed,
    admitted: false,
  },
  {
    label: 'a supported module fix-target pin',
    pin: { ...empty, fixTarget: { stepId: 'module.fx.repair', capabilityVersion: 1 } },
    admitted: true,
  },
  {
    label: 'a guarded mid-span pin',
    pin: {
      ...guarded,
      guardedSpans: [{ ...guarded.guardedSpans[0]!, firstStepId: STEP }],
    },
    admitted: true,
  },
])(
  'allows Stop on $label; the following Resume is admitted only when supported',
  async ({ pin, admitted }) => {
    const fake = stopped(pin, 'running');
    if ('fixTarget' in pin && pin.fixTarget.stepId === 'module.fx.repair') {
      // This API gate reads the pin; the Postgres agreement harness checks live module support.
      fake.patch(schema.tasks, TASK, { runListSnapshot: [pin.fixTarget.stepId, STEP, 'report'] });
    }
    await fake.db.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, TASK));
    const app = new Hono<AppEnv>();
    app.route('/tasks', taskRoutes);
    app.onError(errorHandler);
    const stop = await app.request(`/tasks/${TASK}/cancel-active-cli`, { method: 'POST' });
    expect(stop.status, await stop.clone().text()).toBe(200);
    expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'failed', executionContract: pin });
    expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ status: 'failed' });
    const before = admitted ? null : state(fake);
    h.kill.mockClear();
    h.add.mockClear();
    const resume = await app.request(`/tasks/${TASK}/steps/${STEP}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume', round: 0 }),
    });
    if (admitted) {
      expect(resume.status, await resume.clone().text()).toBe(200);
      expect(fake.rows(schema.taskEvents).map((e) => e.eventType)).toContain('step.resume');
      expect(h.add).toHaveBeenCalledWith('advance-step', expect.anything(), expect.anything());
      return;
    }
    expect(resume.status).toBe(409);
    expect(await resume.json()).toMatchObject({ code: 'invalid-execution-contract' });
    expect(state(fake)).toEqual(before);
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.add).not.toHaveBeenCalled();
  },
);

it.each([
  { label: 'task Cancel', path: '/action', action: 'cancel' },
  { label: 'step Abort', path: `/steps/${STEP}/action`, action: 'abort' },
])('keeps $label available on a guarded pin', async ({ path, action }) => {
  const fake = stopped(guarded, 'running');
  await fake.db.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, TASK));
  const app = new Hono<AppEnv>();
  app.route('/tasks', taskRoutes);
  app.onError(errorHandler);
  const res = await app.request(`/tasks/${TASK}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, round: 0 }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  expect(fake.rows(schema.tasks)[0]).toMatchObject({
    status: 'cancelled',
    executionContract: guarded,
  });
  expect(h.add).toHaveBeenCalledWith(
    'cancel-task',
    expect.objectContaining({ taskId: TASK }),
    expect.anything(),
  );
});

it('admits a capable module target and copies the execution pin at locked admission', async () => {
  const target = 'module.fx.repair';
  const pin = { ...empty, fixTarget: { stepId: target, capabilityVersion: 1 } };
  const fake = setup(pin);
  fake.insert(schema.modules, {
    moduleId: 'fx',
    packageName: '@haive/module-fx',
    name: 'Fx',
    installedVersion: '1',
  });
  fake.insert(schema.stepCatalog, {
    stepId: target,
    source: 'module:fx',
    workflowType: 'module.fx',
    composable: true,
    dispatchesCli: false,
    stepIndex: 2,
    entry: {
      stepId: target,
      label: 'Repair',
      group: 'build',
      dispatchesCli: false,
      requires: [],
      provides: [],
      fixConsumer: { version: 1 },
    },
  });
  await fake.db
    .update(schema.taskTypeDefinitions)
    .set({ stepIds: ['lead', target, 'tail'] })
    .where(eq(schema.taskTypeDefinitions.slug, 'test'));
  const definition = await fake.db.transaction((tx) =>
    definitionForCreate(tx as never, 'test', { generic: true, locked: true }),
  );
  expect(definition.executionContract).toEqual(pin);
  expect(definition.runListSnapshot).toContain(target);
  // The catalog cannot grant a capability the step never declared.
  const stored = fake.rows(schema.stepCatalog).find((row) => row.stepId === target)!;
  await fake.db
    .update(schema.stepCatalog)
    .set({ entry: { ...(stored.entry as object), fixConsumer: undefined } })
    .where(eq(schema.stepCatalog.stepId, target));
  await expect(
    fake.db.transaction((tx) =>
      definitionForCreate(tx as never, 'test', { generic: true, locked: true }),
    ),
  ).rejects.toMatchObject({
    status: 409,
    code: 'invalid-execution-contract',
    message: expect.stringContaining(target),
  });
});
