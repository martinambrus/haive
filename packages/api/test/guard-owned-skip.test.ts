import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
  kill: vi.fn(async (_taskId: string) => 0),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: h.kill }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { taskRoutes } from '../src/routes/tasks/index.js';
import { enrichStepsWithSkipFlag, isStepSkippable } from '../src/routes/tasks/_helpers.js';
import { loadTaskStepFlags } from '../src/lib/step-flags.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
import { seedStepCatalog } from './step-flags-fixture.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const PRE = '00000000-0000-4000-8000-0000000000b1';
const ENTRY = '00000000-0000-4000-8000-0000000000b2';
const MEMBER = '00000000-0000-4000-8000-0000000000b3';
const TAIL = '00000000-0000-4000-8000-0000000000b4';
const ENTRY_STEP = '11d-skill-sync';
const OTHER_SKIPPABLE = '01e-external-kb-sync';
const MEMBER_STEP = 'member-step';
const pin = (firstStepId = ENTRY_STEP) => ({
  version: 1,
  guardedSpans: [
    {
      id: 'span',
      firstStepId,
      lastStepId: MEMBER_STEP,
      predicateId: 'module.fx.planned',
      args: {},
    },
  ],
});
const decision = { run: false };
const receipt = { kind: 'guard-skip', spanId: 'span' };

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);

beforeEach(() => {
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
  h.add.mockClear();
  h.kill.mockClear();
});

type Rows = { entry?: Record<string, unknown>; member?: Record<string, unknown> };
function setup(rows: Rows = {}, contract: unknown = pin()) {
  const fake = createFakeDb({
    modules: schema.modules,
    stepCatalog: schema.stepCatalog,
    repositories: schema.repositories,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
    taskStepCliChoices: schema.taskStepCliChoices,
    taskDatabaseStates: schema.taskDatabaseStates,
  });
  seedStepCatalog(fake);
  fake.insert(schema.repositories, {
    id: USER,
    userId: USER,
    name: 'repo',
    source: 'git_https',
    status: 'ready',
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: USER,
    status: 'failed',
    errorMessage: 'boom',
    executionContract: contract,
    orchestrationEpoch: 3,
    currentStepId: MEMBER_STEP,
    currentRound: 0,
    completedAt: fake.now(),
  });
  const row = (id: string, stepId: string, runSeq: number, values: Record<string, unknown>) =>
    fake.insert(schema.taskSteps, {
      id,
      taskId: TASK,
      stepId,
      stepIndex: runSeq,
      runSeq,
      round: 0,
      title: stepId,
      idleMs: 0,
      carriedWorkMs: 0,
      carriedIdleMs: 0,
      carriedUserActiveMs: 0,
      userActiveMs: 0,
      ...values,
    });
  row(PRE, 'pre-step', 1, { status: 'done', output: { a: 1 } });
  row(ENTRY, ENTRY_STEP, 2, {
    status: 'skipped',
    guardState: decision,
    ...rows.entry,
  });
  row(MEMBER, MEMBER_STEP, 3, {
    status: 'skipped',
    guardState: receipt,
    ...rows.member,
  });
  row(TAIL, 'tail-step', 4, { status: 'pending' });
  h.db = fake.db;
  const act = (stepId: string, action: string) =>
    app.request(`/${TASK}/steps/${stepId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, round: 0 }),
    });
  const step = (id: string) => fake.rows(schema.taskSteps).find((r) => r.id === id)!;
  const snapshot = () =>
    JSON.stringify([
      fake.rows(schema.tasks),
      fake.rows(schema.taskSteps),
      fake.rows(schema.taskEvents),
      fake.rows(schema.cliInvocations),
    ]);
  const events = () => fake.rows(schema.taskEvents).map((e) => e.eventType);
  return { fake, act, step, snapshot, events };
}

describe('Retry of a member the guard skipped', () => {
  it('is refused with guard-owned-skip before any reset, event, kill, epoch bump or job', async () => {
    const t = setup();
    const before = t.snapshot();
    const res = await t.act(MEMBER_STEP, 'retry');
    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'guard-owned-skip' });
    expect(t.snapshot()).toBe(before);
    expect(t.events()).toEqual([]);
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.add).not.toHaveBeenCalled();
  });

  it.each([
    ['the span entry (decision run:false, skipped)', ENTRY_STEP],
    ['a step upstream of the span', 'pre-step'],
  ])('is allowed on %s and resets the entry and every member', async (_label, stepId) => {
    const t = setup();
    const res = await t.act(stepId, 'retry');
    expect(res.status, await res.clone().text()).toBe(200);
    for (const id of [ENTRY, MEMBER, TAIL])
      expect(t.step(id)).toMatchObject({ status: 'pending', guardState: null });
    expect(t.fake.rows(schema.tasks)[0]).toMatchObject({
      status: 'running',
      orchestrationEpoch: 4,
    });
    expect(t.events()).toEqual(['step.retry']);
    expect(h.add).toHaveBeenCalledWith('advance-step', expect.anything(), expect.anything());
  });

  it('is allowed on a skipped row that carries no guard state', async () => {
    const t = setup({ member: { guardState: null } });
    const res = await t.act(MEMBER_STEP, 'retry');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(t.step(MEMBER)).toMatchObject({ status: 'pending', guardState: null });
    expect(t.fake.rows(schema.tasks)[0]).toMatchObject({ orchestrationEpoch: 4 });
    expect(t.events()).toEqual(['step.retry']);
    expect(h.add).toHaveBeenCalledTimes(1);
  });

  it('is allowed on a failed member', async () => {
    const t = setup({ member: { status: 'failed', guardState: null } });
    const res = await t.act(MEMBER_STEP, 'retry');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(t.step(MEMBER)).toMatchObject({ status: 'pending' });
    expect(t.fake.rows(schema.tasks)[0]).toMatchObject({ orchestrationEpoch: 4 });
    expect(t.events()).toEqual(['step.retry']);
    expect(h.add).toHaveBeenCalledTimes(1);
  });
});

describe('a span entry is not user-skippable', () => {
  const parked = { entry: { status: 'waiting_form', guardState: null } };
  it('Skip on the entry while waiting_form is refused with 409 and no side effect', async () => {
    const t = setup(parked);
    const before = t.snapshot();
    const res = await t.act(ENTRY_STEP, 'skip');
    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.json()).not.toMatchObject({ code: 'invalid-execution-contract' });
    expect(t.snapshot()).toBe(before);
    expect(t.events()).toEqual([]);
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('Skip on a skippable step that is not an entry stays allowed', async () => {
    const t = setup(parked, pin(OTHER_SKIPPABLE));
    const res = await t.act(ENTRY_STEP, 'skip');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(t.step(ENTRY)).toMatchObject({ status: 'skipped' });
    expect(t.events()).toContain('step.skip');
  });

  it('isStepSkippable and canSkip agree', async () => {
    const t = setup(parked);
    const task = t.fake.rows(schema.tasks)[0]!;
    const flags = await loadTaskStepFlags(t.fake.db as never, task as never);
    expect(isStepSkippable(flags, ENTRY_STEP, task)).toBe(false);
    expect(isStepSkippable(flags, OTHER_SKIPPABLE, task)).toBe(true);
    const enriched = await enrichStepsWithSkipFlag(
      t.fake.db as never,
      flags,
      TASK,
      t.fake.rows(schema.taskSteps).map((r) => ({
        id: r.id as string,
        status: r.status as string,
        stepId: r.stepId as string,
      })),
    );
    expect(enriched.find((r) => r.stepId === ENTRY_STEP)?.canSkip).toBe(false);
  });

  it('canSkip stays true for the same step when the pin names another entry', async () => {
    const t = setup(parked, pin(OTHER_SKIPPABLE));
    const task = t.fake.rows(schema.tasks)[0]!;
    const flags = await loadTaskStepFlags(t.fake.db as never, task as never);
    const enriched = await enrichStepsWithSkipFlag(
      t.fake.db as never,
      flags,
      TASK,
      t.fake.rows(schema.taskSteps).map((r) => ({
        id: r.id as string,
        status: r.status as string,
        stepId: r.stepId as string,
      })),
    );
    expect(enriched.find((r) => r.stepId === ENTRY_STEP)?.canSkip).toBe(true);
  });
});

describe('guardEntryRetryable', () => {
  it('is true only for a guard-skipped span entry', async () => {
    const t = setup();
    const task = t.fake.rows(schema.tasks)[0]!;
    const flags = await loadTaskStepFlags(t.fake.db as never, task as never);
    const enriched = await enrichStepsWithSkipFlag(
      t.fake.db as never,
      flags,
      TASK,
      t.fake.rows(schema.taskSteps).map((r) => ({
        id: r.id as string,
        status: r.status as string,
        stepId: r.stepId as string,
        guardState: r.guardState,
      })),
    );
    const flag = (stepId: string) =>
      (enriched.find((r) => r.stepId === stepId) as { guardEntryRetryable?: boolean })
        .guardEntryRetryable;
    expect(flag(ENTRY_STEP)).toBe(true);
    expect(flag(MEMBER_STEP)).toBe(false);
    expect(flag('pre-step')).toBe(false);
    expect(flag('tail-step')).toBe(false);
  });

  it('is false for an ordinary auto-skipped step without guard state', async () => {
    const t = setup({ entry: { guardState: null } });
    const task = t.fake.rows(schema.tasks)[0]!;
    const flags = await loadTaskStepFlags(t.fake.db as never, task as never);
    const enriched = await enrichStepsWithSkipFlag(
      t.fake.db as never,
      flags,
      TASK,
      t.fake.rows(schema.taskSteps).map((r) => ({
        id: r.id as string,
        status: r.status as string,
        stepId: r.stepId as string,
        guardState: r.guardState,
      })),
    );
    expect(
      (enriched.find((r) => r.stepId === ENTRY_STEP) as { guardEntryRetryable?: boolean })
        .guardEntryRetryable,
    ).toBe(false);
  });
});
