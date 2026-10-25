import { beforeEach, expect, it, vi } from 'vitest';
const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(k: string, v: string): void }, next: () => Promise<void>) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const TASK = '00000000-0000-4000-8000-000000000001';
const STEP = '11a-gate-4-push';
const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);
let fake: ReturnType<typeof createFakeDb>;
beforeEach(() => {
  h.add.mockReset();
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});
function setup(stepId = STEP, userId = USER, status = 'running') {
  fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.tasks, { id: TASK, userId, status, type: 'workflow', orchestrationEpoch: 4 });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId,
    round: 2,
    status: 'waiting_form',
    idleMs: 0,
    waitingStartedAt: new Date(),
    formValues: null,
  });
  h.db = fake.db;
}
const submit = (values: unknown, stepId = STEP) =>
  app.request(`/${TASK}/steps/${stepId}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values }),
  });
const durable = () =>
  JSON.stringify({
    steps: fake.rows(schema.taskSteps),
    events: fake.rows(schema.taskEvents),
    jobs: h.add.mock.calls,
  });
it.each([
  ['https://fixture-user:fixture-password@example.test:443/repo', 'https://example.test:443/repo'],
  ['ssh://git:fixture-password@example.test:22/repo', 'ssh://git@example.test:22/repo'],
])(
  'normalizes gate remote credentials before stored answers, events and queue jobs: case %#',
  async (remoteUrl, expected) => {
    setup();
    const res = await submit({
      push: true,
      remoteUrl,
      setUpstream: true,
      note: 'keep this',
    });
    expect(res.status).toBe(200);
    expect(durable().includes('fixture-password')).toBe(false);
    expect(durable().includes('fixture-user')).toBe(false);
    expect(fake.rows(schema.taskSteps)[0]?.formValues).toEqual({
      push: true,
      remoteUrl: expected,
      setUpstream: true,
      note: 'keep this',
    });
    expect(h.add.mock.calls[0]?.[1]).toMatchObject({
      round: 2,
      formValues: { remoteUrl: expected },
    });
  },
);
it.each([
  'file://fixture-user:fixture-password@example.test/repo',
  'https://fixture-user:fixture-password@/repo',
])(
  'refuses invalid gate URL case %# without echoing or persisting credentials',
  async (remoteUrl) => {
    setup();
    const res = await submit({ push: true, remoteUrl });
    expect(res.status).toBe(400);
    expect((await res.text()).includes('fixture-password')).toBe(false);
    expect(fake.rows(schema.taskSteps)[0]?.formValues).toBeNull();
    expect(fake.rows(schema.taskEvents)).toHaveLength(0);
    expect(h.add).not.toHaveBeenCalled();
  },
);
it.each([
  '',
  '   ',
  'https://example.test:443/repo',
  'ssh://git@example.test:22/repo',
  'git@example.test:repo',
])('preserves clean and optional gate remote case %#', async (remoteUrl) => {
  setup();
  expect((await submit({ push: false, remoteUrl })).status).toBe(200);
  expect(fake.rows(schema.taskSteps)[0]?.formValues).toEqual({ push: false, remoteUrl });
});
it('leaves unrelated form answer semantics intact', async () => {
  setup('custom.example.form');
  const values = {
    remoteUrl: 'a free-form answer',
    nested: { url: 'https://fixture-user:fixture-password@example.test/repo' },
  };
  expect((await submit(values, 'custom.example.form')).status).toBe(200);
  expect(
    JSON.stringify(fake.rows(schema.taskSteps)[0]?.formValues) === JSON.stringify(values),
  ).toBe(true);
});
it('preserves ownership refusal before URL validation', async () => {
  setup(STEP, TASK);
  const res = await submit({ remoteUrl: 'bad' });
  expect(res.status).toBe(404);
  expect(h.add).not.toHaveBeenCalled();
});
it('uses the latest waiting round and leaves previous answers intact', async () => {
  setup();
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: STEP,
    round: 0,
    status: 'done',
    formValues: { note: 'previous answer' },
  });
  expect(
    (
      await submit({
        push: true,
        remoteUrl: 'https://fixture-user:fixture-password@example.test/repo',
      })
    ).status,
  ).toBe(200);
  const rows = fake.rows(schema.taskSteps);
  expect(rows.find((r) => r.round === 0)?.formValues).toEqual({ note: 'previous answer' });
  expect(JSON.stringify(h.add.mock.calls).includes('fixture-password')).toBe(false);
  expect(h.add.mock.calls[0]?.[1]).toMatchObject({ round: 2 });
});
it('does not update answers or queue when the task is dead', async () => {
  setup();
  fake.patch(schema.tasks, TASK, { deadAt: new Date(), deadReason: 'missing step' });
  expect((await submit({ remoteUrl: 'bad' })).status).toBe(409);
  expect(fake.rows(schema.taskSteps)[0]?.formValues).toBeNull();
  expect(h.add).not.toHaveBeenCalled();
});
it('keeps a failed task blocked during maintenance before validating its remote', async () => {
  setup(STEP, USER, 'failed');
  vi.spyOn(configService, 'getFresh').mockResolvedValue('maintenance');
  expect((await submit({ remoteUrl: 'bad' })).status).toBe(503);
  expect(fake.rows(schema.taskSteps)[0]?.formValues).toBeNull();
  expect(h.add).not.toHaveBeenCalled();
});
