import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

const h = vi.hoisted(() => ({ db: undefined as unknown, add: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { stepRoutes } from '../src/routes/tasks/steps.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const STEP = '02-plan-chat';
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', stepRoutes);
app.onError(errorHandler);
beforeEach(() => {
  h.add.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network request');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

it('refuses a PostgreSQL file parameter before persisting a tooling form', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  const stepId = '04-tooling-infrastructure';
  fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'running' });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId,
    status: 'waiting_form',
    round: 0,
    idleMs: 0,
    waitingStartedAt: fake.now(),
  });
  h.db = fake.db;
  h.add.mockResolvedValueOnce(undefined);
  const before = structuredClone(fake.rows(schema.taskSteps));
  const res = await app.request(`/${TASK}/steps/${stepId}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      values: {
        ragMode: 'external',
        ragConnectionString: `postgres://user:${randomBytes(12).toString('hex')}@db.invalid/store?sslkey=`,
      },
    }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({
    code: 'user_postgres_dsn_refused',
    error: expect.stringContaining('"sslkey"'),
  });
  expect(fake.rows(schema.taskSteps)).toEqual(before);
  expect(h.add).not.toHaveBeenCalled();
});

it.each(['running', 'done', 'failed'])(
  'returns a stable code when the step is %s rather than awaiting a form',
  async (status) => {
    const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
    fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'running' });
    fake.insert(schema.taskSteps, { taskId: TASK, stepId: STEP, status, round: 0 });
    h.db = fake.db;
    const before = structuredClone(fake.rows(schema.taskSteps));
    const res = await app.request(`/${TASK}/steps/${STEP}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { message: 'Follow up' } }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `No step awaiting form submission for id ${STEP}`,
      code: 'step_form_not_waiting',
    });
    expect(fake.rows(schema.taskSteps)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
  },
);

it.each(['running', 'done', 'failed'])(
  'returns the same stable code when clarification step is %s rather than awaiting a form',
  async (status) => {
    const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
    fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'running' });
    fake.insert(schema.taskSteps, { taskId: TASK, stepId: STEP, status, round: 0 });
    h.db = fake.db;
    const before = structuredClone(fake.rows(schema.taskSteps));
    const res = await app.request(`/${TASK}/steps/${STEP}/clarify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'Keep both changes' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `No step awaiting clarification for id ${STEP}`,
      code: 'step_form_not_waiting',
    });
    expect(fake.rows(schema.taskSteps)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
  },
);

it('answers 200 with queued false when the queue never answers, the form write standing', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'waiting_user' });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: STEP,
    status: 'waiting_form',
    round: 0,
    idleMs: 0,
    waitingStartedAt: fake.now(),
  });
  h.db = fake.db;
  h.add.mockImplementationOnce(() => new Promise(() => undefined));
  const res = await app.request(`/${TASK}/steps/${STEP}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { message: 'Follow up' } }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, queued: false });
  expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ formValues: { message: 'Follow up' } });
}, 10_000);

it('answers queued true when the queue accepts', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'waiting_user' });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: STEP,
    status: 'waiting_form',
    round: 0,
    idleMs: 0,
    waitingStartedAt: fake.now(),
  });
  h.db = fake.db;
  h.add.mockResolvedValueOnce(undefined);
  const res = await app.request(`/${TASK}/steps/${STEP}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { message: 'Follow up' } }),
  });
  expect(await res.json()).toEqual({ ok: true, queued: true });
});

it('binds a gate-2 human decision to the authenticated owner and parked generation', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  const stepId = '09-gate-2-verify-approval';
  fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'waiting_user' });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId,
    status: 'waiting_form',
    round: 2,
    rerunGeneration: 3,
    idleMs: 0,
    waitingStartedAt: fake.now(),
  });
  h.db = fake.db;
  h.add.mockResolvedValueOnce(undefined);
  const response = await app.request(`/${TASK}/steps/${stepId}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { decision: 'approve' } }),
  });
  expect(response.status).toBe(200);
  expect(fake.rows(schema.taskEvents)).toEqual([
    expect.objectContaining({
      taskId: TASK,
      taskStepId: fake.rows(schema.taskSteps)[0]!.id,
      eventType: 'step.form_submitted',
      payload: expect.objectContaining({ userId: USER, generation: 3, decision: 'approve' }),
    }),
  ]);
  expect(fake.rows(schema.taskSteps)[0]).toMatchObject({
    waitingStartedAt: null,
    formValues: { decision: 'approve' },
  });
});

const GATE2 = '09-gate-2-verify-approval';
const GATE3 = '10-gate-3-commit';
const PARK = new Date('2026-01-02T03:04:05.678Z');
const STALE_PARK = new Date('2026-01-02T03:00:00.000Z');

function gateFixture(opts: {
  stepId: string;
  kinds?: Array<Record<string, unknown>>;
  waitingStartedAt?: Date | null;
  round?: number;
}) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    status: 'waiting_user',
    orchestrationEpoch: 6,
  });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: opts.stepId,
    status: 'waiting_form',
    round: opts.round ?? 0,
    rerunGeneration: 1,
    idleMs: 0,
    waitingStartedAt: opts.waitingStartedAt === undefined ? PARK : opts.waitingStartedAt,
  });
  (opts.kinds ?? []).forEach((payload, i) =>
    fake.insert(schema.taskEvents, {
      taskId: TASK,
      eventType: 'insight.check',
      payload,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    }),
  );
  h.db = fake.db;
  h.add.mockResolvedValue(undefined);
  const stepRowId = () => fake.rows(schema.taskSteps)[0]!.id as string;
  return { fake, stepRowId };
}

const check = (kind: string, extra: Record<string, unknown> = {}) => ({
  version: 1,
  batchId: 'x',
  kind,
  ...extra,
});

async function postGate(stepId: string, extra: Record<string, unknown>, values?: unknown) {
  return app.request(`/${TASK}/steps/${stepId}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      values: values ?? (stepId === GATE2 ? { decision: 'approve' } : { commit: true }),
      ...extra,
    }),
  });
}

async function expectRefused(
  res: Response,
  fake: ReturnType<typeof gateFixture>['fake'],
  before: { steps: unknown; events: unknown },
) {
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'step_form_stale' });
  expect(fake.rows(schema.taskSteps)).toEqual(before.steps);
  expect(fake.rows(schema.taskEvents)).toEqual(before.events);
  expect(h.add).not.toHaveBeenCalled();
}

const snap = (fake: ReturnType<typeof gateFixture>['fake']) => ({
  steps: structuredClone(fake.rows(schema.taskSteps)),
  events: structuredClone(fake.rows(schema.taskEvents)),
});

it.each([
  [
    'a stale row id',
    (id: string) => ({ stepRowId: `${id}-x`, waitingStartedAt: PARK.toISOString() }),
  ],
  [
    'a stale park stamp',
    (id: string) => ({ stepRowId: id, waitingStartedAt: STALE_PARK.toISOString() }),
  ],
  ['no fields', () => ({})],
  ['a garbage stamp', (id: string) => ({ stepRowId: id, waitingStartedAt: 'not a date' })],
])('refuses a latched gate-2 answer with %s', async (_name, fields) => {
  const { fake, stepRowId } = gateFixture({ stepId: GATE2, kinds: [check('verify_failed')] });
  const before = snap(fake);
  const res = await postGate(GATE2, fields(stepRowId()));
  await expectRefused(res, fake, before);
});

it('accepts a latched gate-2 answer that carries the form it was rendered for', async () => {
  const { fake, stepRowId } = gateFixture({ stepId: GATE2, kinds: [check('verify_failed')] });
  const res = await postGate(GATE2, {
    stepRowId: stepRowId(),
    waitingStartedAt: PARK.toISOString(),
  });
  expect(res.status).toBe(200);
  expect(fake.rows(schema.taskEvents).map((e) => e.eventType)).toContain('step.form_submitted');
  expect(
    fake.rows(schema.taskEvents).find((e) => e.eventType === 'step.form_submitted'),
  ).toMatchObject({
    payload: expect.objectContaining({ userId: USER, generation: 1, decision: 'approve' }),
  });
});

it.each([GATE2, GATE3])(
  'requeues an identical retry of the saved latched %s answer without another write',
  async (stepId) => {
    const { fake, stepRowId } = gateFixture({
      stepId,
      kinds: [check(stepId === GATE2 ? 'verify_failed' : 'gate2_approved')],
    });
    const binding = { stepRowId: stepRowId(), waitingStartedAt: PARK.toISOString() };
    expect((await postGate(stepId, binding)).status).toBe(200);
    const before = {
      steps: fake.rows(schema.taskSteps).map((row) => ({ ...row })),
      events: [...fake.rows(schema.taskEvents)],
    };
    const firstId = h.add.mock.calls[0]![2].deduplication.id;
    h.add.mockClear();
    const response = await postGate(stepId, binding);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, queued: true });
    expect(fake.rows(schema.taskSteps)).toEqual(before.steps);
    expect(fake.rows(schema.taskEvents)).toEqual(before.events);
    expect(h.add).toHaveBeenCalledOnce();
    expect(h.add.mock.calls[0]![2].deduplication.id).toBe(firstId);
    expect(h.add.mock.calls[0]![1].epoch).toBe(6);
  },
);

it('binds a latched gate-3 answer the same way', async () => {
  const stale = gateFixture({ stepId: GATE3, kinds: [check('gate2_approved')] });
  const before = snap(stale.fake);
  const refused = await postGate(GATE3, {
    stepRowId: stale.stepRowId(),
    waitingStartedAt: STALE_PARK.toISOString(),
  });
  await expectRefused(refused, stale.fake, before);
  h.add.mockReset();
  const ok = gateFixture({ stepId: GATE3, kinds: [check('gate2_approved')] });
  const res = await postGate(GATE3, {
    stepRowId: ok.stepRowId(),
    waitingStartedAt: PARK.toISOString(),
  });
  expect(res.status).toBe(200);
  expect(ok.fake.rows(schema.taskEvents).at(-1)).toMatchObject({
    eventType: 'step.form_submitted',
    payload: expect.objectContaining({ commit: true }),
  });
});

it('binds a gate-3 answer below the approval round the same way', async () => {
  const kinds = [check('gate2_approved', { round: 3 })];
  const stale = gateFixture({ stepId: GATE3, kinds, round: 2 });
  const before = snap(stale.fake);
  const unbound = await postGate(GATE3, {});
  await expectRefused(unbound, stale.fake, before);
  h.add.mockReset();
  const refused = await postGate(GATE3, {
    stepRowId: stale.stepRowId(),
    waitingStartedAt: STALE_PARK.toISOString(),
  });
  await expectRefused(refused, stale.fake, before);
  h.add.mockReset();
  const ok = gateFixture({ stepId: GATE3, kinds, round: 2 });
  const res = await postGate(GATE3, {
    stepRowId: ok.stepRowId(),
    waitingStartedAt: PARK.toISOString(),
  });
  expect(res.status).toBe(200);
  expect(ok.fake.rows(schema.taskEvents).at(-1)).toMatchObject({
    eventType: 'step.form_submitted',
    payload: expect.objectContaining({ commit: true }),
  });
});

it.each([
  ['gate 2 after an approval', GATE2, [check('gate2_approved')]],
  ['gate 2 with no check event', GATE2, []],
  ['gate 3 after a failed verify', GATE3, [check('verify_failed')]],
  ['gate 3 with no check event', GATE3, []],
])('needs no fields for an unlatched gate: %s', async (_name, stepId, kinds) => {
  const { fake } = gateFixture({ stepId, kinds });
  const res = await postGate(stepId, {});
  expect(res.status).toBe(200);
  expect(fake.rows(schema.taskEvents).map((e) => e.eventType)).toContain('step.form_submitted');
});

it('reads the LATEST check event to decide the latch', async () => {
  const { fake } = gateFixture({
    stepId: GATE2,
    kinds: [check('verify_failed'), check('gate2_approved')],
  });
  expect((await postGate(GATE2, {})).status).toBe(200);
  expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ waitingStartedAt: null });
});

it('ignores the binding fields for an ordinary step', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'waiting_user' });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: STEP,
    status: 'waiting_form',
    round: 0,
    idleMs: 0,
    waitingStartedAt: PARK,
  });
  h.db = fake.db;
  h.add.mockResolvedValueOnce(undefined);
  const res = await app.request(`/${TASK}/steps/${STEP}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      values: { message: 'hi' },
      stepRowId: 'someone-else',
      waitingStartedAt: STALE_PARK.toISOString(),
    }),
  });
  expect(res.status).toBe(200);
});

it('fails closed when the latest check event cannot be read', async () => {
  const { fake } = gateFixture({ stepId: GATE2, kinds: [{ version: 2, kind: 'gate2_approved' }] });
  const before = snap(fake);
  const res = await postGate(GATE2, {});
  await expectRefused(res, fake, before);
});

it.each([null, PARK.toISOString()])(
  'refuses a latched answer to a wait that was already answered (stamp sent: %s)',
  async (sent) => {
    const { fake, stepRowId } = gateFixture({
      stepId: GATE2,
      kinds: [check('verify_failed')],
      waitingStartedAt: null,
    });
    const before = snap(fake);
    const res = await postGate(GATE2, { stepRowId: stepRowId(), waitingStartedAt: sent });
    await expectRefused(res, fake, before);
  },
);

const cycleEvent = (extra: Record<string, unknown> = {}) => ({
  continuation: {
    version: 1,
    kind: 'insight_revise',
    batchId: 'x',
    sourceStepRow: 'source-row',
    generation: 0,
    round: 1,
    mode: 'gate3',
    stage: 'apply',
    ...extra,
  },
  targetStepId: '08e-insights-triage',
});

function gateFixtureWithContinuation(stepId: string, payload: Record<string, unknown>) {
  const fixture = gateFixture({ stepId });
  fixture.fake.insert(schema.taskEvents, {
    taskId: TASK,
    eventType: 'insight.continuation',
    payload,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
  });
  return fixture;
}

it.each([
  [
    'a stale row id',
    (id: string) => ({ stepRowId: `${id}-x`, waitingStartedAt: PARK.toISOString() }),
  ],
  [
    'a stale park stamp',
    (id: string) => ({ stepRowId: id, waitingStartedAt: STALE_PARK.toISOString() }),
  ],
  ['no fields', () => ({})],
  ['a garbage stamp', (id: string) => ({ stepRowId: id, waitingStartedAt: 'not a date' })],
])('refuses a gate-3 answer after a gate-3 insight cycle with %s', async (_name, fields) => {
  const { fake, stepRowId } = gateFixtureWithContinuation(GATE3, cycleEvent());
  const before = snap(fake);
  const res = await postGate(GATE3, fields(stepRowId()));
  await expectRefused(res, fake, before);
});

it('accepts a gate-3 answer after a gate-3 insight cycle that carries the form it was rendered for', async () => {
  const { fake, stepRowId } = gateFixtureWithContinuation(GATE3, cycleEvent());
  const res = await postGate(GATE3, {
    stepRowId: stepRowId(),
    waitingStartedAt: PARK.toISOString(),
  });
  expect(res.status).toBe(200);
  expect(fake.rows(schema.taskEvents).at(-1)).toMatchObject({
    eventType: 'step.form_submitted',
    payload: expect.objectContaining({ userId: USER, generation: 1, commit: true }),
  });
});

/** The Retry shape: the waiting gate-3 row is the cycle's own source row, reset to generation 1 at a
 *  round below the cycle's round. */
function retriedSourceFixture() {
  const fixture = gateFixture({ stepId: GATE3 });
  fixture.fake.insert(schema.taskEvents, {
    taskId: TASK,
    eventType: 'insight.continuation',
    payload: cycleEvent({ sourceStepRow: fixture.stepRowId(), generation: 0, round: 1 }),
    createdAt: new Date(Date.UTC(2026, 0, 1)),
  });
  return fixture;
}

it('refuses an unbound gate-3 answer on the cycle source row re-run below the cycle round', async () => {
  const { fake } = retriedSourceFixture();
  const before = snap(fake);
  const res = await postGate(GATE3, {});
  await expectRefused(res, fake, before);
});

it('accepts a bound gate-3 answer on the cycle source row re-run below the cycle round', async () => {
  const { fake, stepRowId } = retriedSourceFixture();
  const res = await postGate(GATE3, {
    stepRowId: stepRowId(),
    waitingStartedAt: PARK.toISOString(),
  });
  expect(res.status).toBe(200);
  expect(fake.rows(schema.taskEvents).at(-1)).toMatchObject({
    eventType: 'step.form_submitted',
    payload: expect.objectContaining({ userId: USER, generation: 1, commit: true }),
  });
});

it('needs no fields for a gate-3 answer after an automatic round, which is not a gate-3 cycle', async () => {
  const { fake } = gateFixtureWithContinuation(
    GATE3,
    cycleEvent({ mode: undefined, stage: undefined }),
  );
  const res = await postGate(GATE3, {});
  expect(res.status).toBe(200);
  expect(fake.rows(schema.taskEvents).map((e) => e.eventType)).toContain('step.form_submitted');
});

it.each([
  ['an unsupported version', { continuation: { version: 2, kind: 'insight_revise' } }],
  ['no continuation', {}],
])('fails closed when a continuation event cannot be read: %s', async (_name, payload) => {
  const { fake } = gateFixtureWithContinuation(GATE3, payload);
  const before = snap(fake);
  const res = await postGate(GATE3, {});
  await expectRefused(res, fake, before);
});

it.each([
  [
    'a stale row id',
    (id: string) => ({ stepRowId: `${id}-x`, waitingStartedAt: PARK.toISOString() }),
  ],
  [
    'a stale park stamp',
    (id: string) => ({ stepRowId: id, waitingStartedAt: STALE_PARK.toISOString() }),
  ],
  ['no fields', () => ({})],
  ['a garbage stamp', (id: string) => ({ stepRowId: id, waitingStartedAt: 'not a date' })],
])('refuses a gate-2 answer after a gate-3 insight cycle with %s', async (_name, fields) => {
  const { fake, stepRowId } = gateFixtureWithContinuation(GATE2, cycleEvent());
  const before = snap(fake);
  const res = await postGate(GATE2, fields(stepRowId()));
  await expectRefused(res, fake, before);
});

it('accepts a gate-2 answer after a gate-3 insight cycle that carries the form it was rendered for', async () => {
  const { fake, stepRowId } = gateFixtureWithContinuation(GATE2, cycleEvent());
  const res = await postGate(GATE2, {
    stepRowId: stepRowId(),
    waitingStartedAt: PARK.toISOString(),
  });
  expect(res.status).toBe(200);
  expect(fake.rows(schema.taskEvents).at(-1)).toMatchObject({
    eventType: 'step.form_submitted',
    payload: expect.objectContaining({ userId: USER, generation: 1, decision: 'approve' }),
  });
});

it('needs no fields for a gate-2 answer after an automatic round, which is not a gate-3 cycle', async () => {
  const { fake } = gateFixtureWithContinuation(
    GATE2,
    cycleEvent({ mode: undefined, stage: undefined }),
  );
  const res = await postGate(GATE2, {});
  expect(res.status).toBe(200);
  expect(fake.rows(schema.taskEvents).map((e) => e.eventType)).toContain('step.form_submitted');
});

it.each([
  ['an unsupported version', { continuation: { version: 2, kind: 'insight_revise' } }],
  ['no continuation', {}],
])(
  'fails closed for gate 2 when a continuation event cannot be read: %s',
  async (_name, payload) => {
    const { fake } = gateFixtureWithContinuation(GATE2, payload);
    const before = snap(fake);
    const res = await postGate(GATE2, {});
    await expectRefused(res, fake, before);
  },
);
