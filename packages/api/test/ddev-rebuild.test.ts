import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { AppEnv } from '../src/context.js';
const h = vi.hoisted(() => ({
  task: vi.fn(),
  step: vi.fn(),
  cli: vi.fn(),
  add: vi.fn(),
  wait: vi.fn(),
}));
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      tasks: { findFirst: h.task },
      taskSteps: { findFirst: h.step },
      cliInvocations: { findFirst: h.cli },
    },
  }),
}));
vi.mock('../src/queues.js', () => ({
  getRuntimeEnsureQueue: () => ({ add: h.add }),
  getRuntimeEnsureQueueEvents: vi.fn(),
}));
import { browserAccessRoutes } from '../src/routes/tasks/browser-access.js';
import { errorHandler } from '../src/middleware/error-handler.js';
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', 'owner');
  await next();
});
app.onError(errorHandler);
app.route('/tasks', browserAccessRoutes);
const request = () => app.request('/tasks/task/ddev/rebuild', { method: 'POST' });
afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.clearAllMocks();
  h.task.mockResolvedValue({ id: 'task' });
  h.step.mockResolvedValue(undefined);
  h.cli.mockResolvedValue(undefined);
  h.add.mockResolvedValue({ waitUntilFinished: h.wait });
  h.wait.mockResolvedValue({ ok: true, mode: 'ddev', url: null });
});
it('hides another user’s task and enqueues nothing', async () => {
  h.task.mockResolvedValue(undefined);
  expect((await request()).status).toBe(404);
  expect(h.task).toHaveBeenCalledWith({
    where: and(eq(schema.tasks.id, 'task'), eq(schema.tasks.userId, 'owner')),
    columns: { id: true },
  });
  expect(h.add).not.toHaveBeenCalled();
});
it.each(['step', 'cli'] as const)('refuses a live %s using structural columns', async (kind) => {
  h[kind].mockResolvedValue({ id: 'busy' });
  expect((await request()).status).toBe(409);
  expect(h.add).not.toHaveBeenCalled();
});
it('accepts an idle task and coalesces repeated requests', async () => {
  expect((await request()).status).toBe(202);
  expect(h.add).toHaveBeenCalledWith(
    'rebuild-ddev',
    { taskId: 'task', userId: 'owner' },
    { jobId: 'ddev-rebuild-task', removeOnComplete: true, removeOnFail: true },
  );
  expect(h.step).toHaveBeenCalledWith({
    where: and(
      eq(schema.taskSteps.taskId, 'task'),
      inArray(schema.taskSteps.status, ['running', 'waiting_cli']),
    ),
    columns: { id: true },
  });
  expect(h.cli).toHaveBeenCalledWith({
    where: and(
      eq(schema.cliInvocations.taskId, 'task'),
      isNotNull(schema.cliInvocations.startedAt),
      isNull(schema.cliInvocations.endedAt),
      isNull(schema.cliInvocations.supersededAt),
    ),
    columns: { id: true },
  });
});

it.each([
  ['busy', 'The task runner is busy.', true],
  ['probe-unknown', 'Docker could not be probed. Retry when available.', true],
  ['foreign-runner', 'Runner ownership is unproven.', false],
  ['workspace-mismatch', 'Runner workspace does not match.', false],
  ['no-ddev', 'This task has no DDEV runtime.', false],
])('returns a worker %s refusal to the user', async (reason, message, retryable) => {
  h.wait.mockResolvedValue({
    ok: false,
    mode: 'ddev',
    url: null,
    rebuildRefusal: { reason, message, retryable },
  });
  const response = await request();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: message, reason, retryable });
});
it('does not answer success until removal and enqueue finish', async () => {
  let finish!: (value: unknown) => void;
  h.wait.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let answered = false;
  const response = Promise.resolve(request()).then((value) => {
    answered = true;
    return value;
  });
  for (let i = 0; i < 30 && h.wait.mock.calls.length === 0; i++) await Promise.resolve();
  expect(h.wait).toHaveBeenCalledOnce();
  expect(answered).toBe(false);
  expect(h.wait.mock.calls[0]?.[1]).toBe(30_000);
  finish({ ok: true, mode: 'ddev', url: null });
  expect(await (await response).json()).toEqual({ ok: true });
});
it('returns pending when the bounded removal wait expires', async () => {
  vi.useFakeTimers();
  h.wait.mockImplementation(
    (_events, ttl) =>
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('arbitrary BullMQ timeout copy')), ttl);
      }),
  );
  const pending = request();
  await vi.advanceTimersByTimeAsync(30_000);
  const response = await pending;
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: false, pending: true });
});
it.each(['rm', 'audit-insert', 'enqueue'])(
  'returns a finished %s failure as an error, never pending',
  async () => {
    const message = 'DDEV rebuild failed. Try again; recovery may still be needed.';
    h.wait.mockResolvedValueOnce({
      ok: false,
      url: null,
      mode: 'ddev',
      rebuildFailure: { message },
    });
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: message });
  },
);
it('treats a job already gone before its outcome was read as unknown, not failed', async () => {
  h.wait.mockRejectedValueOnce(new Error('arbitrary missing-job copy'));
  const response = await request();
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: false, pending: true });
});
it('refuses when the rebuild could not be queued', async () => {
  h.add.mockRejectedValueOnce(new Error('queue unavailable'));
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'queue_unavailable' });
  expect(h.wait).not.toHaveBeenCalled();
});
