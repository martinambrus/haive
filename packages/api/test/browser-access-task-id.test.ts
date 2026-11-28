import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { configService } from '@haive/shared';
import type { AppEnv } from '../src/context.js';
const h = vi.hoisted(() => ({
  task: vi.fn(),
  add: vi.fn(),
  wait: vi.fn(),
}));
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      tasks: { findFirst: h.task },
      taskSteps: { findFirst: vi.fn().mockResolvedValue(undefined) },
      cliInvocations: { findFirst: vi.fn().mockResolvedValue(undefined) },
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

const canonical = randomUUID();
const spellings = [canonical.toUpperCase(), canonical.replaceAll('-', '')];
const routes = [
  ['access-urls', 'access-urls', `^ensure-${canonical}$`],
  ['db-access', 'db-access', `^ensure-${canonical}$`],
  ['ddev/rebuild', 'ddev/rebuild', `^ddev-rebuild-${canonical}$`],
  ['open-mailpit', 'open-mailpit', `^mailpit-${canonical}-\\d+$`],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  h.task.mockResolvedValue({ id: canonical });
  h.add.mockResolvedValue({ waitUntilFinished: h.wait });
  h.wait.mockResolvedValue({ ok: true, mode: 'ddev', url: null, removed: true, accessUrls: [] });
});

describe('browser access routes use the task row id for queue jobs', () => {
  it.each(routes)('%s', async (_name, path, pattern) => {
    const ids: string[] = [];
    for (const spelling of spellings) {
      expect(spelling).not.toBe(canonical);
      h.add.mockClear();
      await app.request(`/tasks/${spelling}/${path}`, { method: 'POST' });
      expect(h.add).toHaveBeenCalledOnce();
      const [, payload, opts] = h.add.mock.calls[0]!;
      expect(payload).toMatchObject({ taskId: canonical });
      expect(opts.jobId).toMatch(new RegExp(pattern));
      ids.push(path === 'open-mailpit' ? opts.jobId.replace(/-\d+$/, '') : opts.jobId);
    }
    expect(ids[0]).toBe(ids[1]);
  });
});
