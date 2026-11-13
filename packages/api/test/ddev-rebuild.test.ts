import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { AppEnv } from '../src/context.js';
const h = vi.hoisted(() => ({ task: vi.fn(), step: vi.fn(), cli: vi.fn(), add: vi.fn() }));
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
beforeEach(() => {
  vi.clearAllMocks();
  h.task.mockResolvedValue({ id: 'task' });
  h.step.mockResolvedValue(undefined);
  h.cli.mockResolvedValue(undefined);
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
